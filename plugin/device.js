// Thin adapter over the meshcore.js connection so command handlers stay
// backend-agnostic. `to` is the contact public key (Uint8Array, full key —
// the library sends only the 6-byte prefix on the wire). All sends go
// through the command queue (see queue.js).
//
// MAX_TEXT: 133 chars is the documented spec cap and the multi-hop-safe
// floor. Hardware testing showed direct (zero-hop) messages survive to
// ~140 and truncate at 141 — the budget shrinks as the carried path
// grows, so we never send more than 133.
const MAX_TEXT = 133;

function clamp(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function makeDevice(connection, Constants, queue, log, opts) {
  const DM_RETRIES = (opts && opts.dmRetries !== undefined) ? opts.dmRetries : 1;
  const RETRY_GAP_MS = 1000 * ((opts && opts.retryGapSeconds !== undefined)
    ? opts.retryGapSeconds : 5);
  // Auto reset-path on terminal DM delivery failure (design v2.3). When a
  // directed DM exhausts its retries, reset that contact's stored mesh path
  // so the next send floods and relearns a route, then optionally fire ONE
  // recovery copy of the failed DM. Subject to a per-contact cooldown.
  const RESET_ON_FAIL = !(opts && opts.resetPathOnFailure === false); // default true
  const RESEND_AFTER = !(opts && opts.resendAfterPathReset === false); // default true
  const RECOVERY_GAP_MS = 1000 * ((opts && opts.resetRecoveryGapSeconds !== undefined)
    ? opts.resetRecoveryGapSeconds : 3);
  const COOLDOWN_MS = 60000 * ((opts && opts.resetPathCooldownMinutes !== undefined)
    ? opts.resetPathCooldownMinutes : 10);
  // resetAttempts is INTENTIONALLY in-memory, process-lifetime only (design §8):
  // reset attempts are low-cost and the contact set is tiny, so the map cannot
  // grow meaningfully and a restart simply clears stale cooldowns.
  const resetAttempts = new Map(); // FULL pubkey hex -> last attempt ms
  // nowMs is test plumbing for deterministic cooldown; Date.now in production.
  const nowMs = (opts && opts.nowMs) || (() => Date.now());
  const keyHex = (to) => Buffer.from(to).toString('hex'); // internal state key
  const keyPrefix = (to) => Buffer.from(to).slice(0, 6).toString('hex'); // logs only
  const shouldSuppressReset = (to) => {
    const last = resetAttempts.get(keyHex(to));
    return last !== undefined && COOLDOWN_MS > 0 && (nowMs() - last) < COOLDOWN_MS;
  };
  const markResetAttempt = (to) => resetAttempts.set(keyHex(to), nowMs());
  const note = (kind, text) => {
    if (log) {
      log(`OUT ${kind}: ${clamp(text)}`);
    }
  };
  // Track end-to-end delivery of directed sends: the radio reports the
  // expected ack CRC at send time and pushes SendConfirmed when the
  // recipient's ack arrives. On a missed ack, onMiss (if given) fires —
  // used for one automatic retry: marginal multi-hop links lose longer
  // frames probabilistically (field data: 4-char pong delivered, 20-char
  // batt reply lost twice on the same path minutes apart).
  const trackDelivery = (sentResponse, kind, onMiss) => {
    if (!sentResponse || !sentResponse.expectedAckCrc) {
      return sentResponse;
    }
    const crc = sentResponse.expectedAckCrc;
    const waitMs = (sentResponse.estTimeout || 10000) + 5000;
    let timer;
    const onConfirm = (push) => {
      if (push.ackCode !== crc) {
        return; // someone else's ack
      }
      connection.off(Constants.PushCodes.SendConfirmed, onConfirm);
      clearTimeout(timer);
      if (log) {
        log(`DELIVERED ${kind} (round trip ${push.roundTrip}ms)`);
      }
    };
    timer = setTimeout(() => {
      connection.off(Constants.PushCodes.SendConfirmed, onConfirm);
      if (log) {
        log(`NO DELIVERY CONFIRMATION ${kind} (waited ${Math.round(waitMs / 1000)}s)`);
      }
      if (onMiss) {
        onMiss();
      }
    }, waitMs);
    if (timer.unref) {
      timer.unref();
    }
    connection.on(Constants.PushCodes.SendConfirmed, onConfirm);
    return sentResponse;
  };

  // Reset the contact's stored path via the meshcore.js high-level wrapper
  // (Option A — connection.resetPath confirmed present on the target runtime,
  // v1.13.0). Wrapped in queue.run, which is the outer time bound; queue
  // timeout does NOT cancel any underlying library promise (design §8).
  const resetPath = (to) => queue.run(() => connection.resetPath(to), 'resetPath').then(
    () => {
      if (log) {
        log(`PATH RESET ${keyPrefix(to)} after ${DM_RETRIES + 1} failed attempts`);
      }
      return true;
    },
    (e) => {
      if (log) {
        log(`PATH RESET FAILED ${keyPrefix(to)}: ${e && e.message ? e.message : e}`);
      }
      return false;
    },
  );

  // One recovery copy of the failed DM after a reset. Tracked for logging
  // only (onMiss=null) so it never recurses into another retry/reset/resend.
  const sendRecoveryDm = (text, to) => {
    note('dm recovery', text);
    return queue.run(
      () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
      'sendTextRecovery',
    ).then((sent) => trackDelivery(sent, 'dm recovery', null));
  };

  const handleTerminalMiss = (text, to) => {
    if (!RESET_ON_FAIL) {
      return;
    }
    if (shouldSuppressReset(to)) {
      if (log) {
        log(`PATH RESET SUPPRESSED ${keyPrefix(to)} — cooldown active`);
      }
      return;
    }
    markResetAttempt(to);
    resetPath(to).then((ok) => {
      if (!ok || !RESEND_AFTER) {
        return;
      }
      const t = setTimeout(() => {
        if (log) {
          log(`DM RECOVERY RESEND ${keyPrefix(to)} after path reset`);
        }
        // Catch the detached resend so a queue timeout / send throw cannot
        // become an unhandled rejection (non-goal §2).
        sendRecoveryDm(text, to).catch((e) => {
          if (log) {
            log(`DM RECOVERY RESEND FAILED ${keyPrefix(to)}: ${e && e.message ? e.message : e}`);
          }
        });
      }, RECOVERY_GAP_MS);
      if (t.unref) {
        t.unref();
      }
    });
  };

  const sendDm = (text, to, attempt) => {
    note(attempt ? `dm retry ${attempt}` : 'dm', text);
    return queue.run(
      () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
      'sendText',
    ).then((sent) => trackDelivery(
      sent,
      attempt ? `dm retry ${attempt}` : 'dm',
      attempt < DM_RETRIES
        ? () => { setTimeout(() => sendDm(text, to, attempt + 1), RETRY_GAP_MS); }
        : () => { handleTerminalMiss(text, to); },
    ));
  };

  return {
    maxTextLength: MAX_TEXT,
    // The radio's own telemetry (battery + sensors incl. GPS when fitted).
    // meshcore.js wraps only the remote form; the self form is the same
    // command with no destination key (4-byte frame, answered locally
    // over serial — no airtime). selfPubKeyPrefix guards against a late
    // remote TelemetryResponse being misread as our own.
    getSelfTelemetry: (selfPubKeyPrefix) => queue.run(
      () => new Promise((resolve, reject) => {
        const prefixHex = Buffer.from(selfPubKeyPrefix).toString('hex');
        const onPush = (response) => {
          if (Buffer.from(response.pubKeyPrefix).toString('hex') !== prefixHex) {
            return; // someone else's telemetry — keep waiting
          }
          connection.off(Constants.PushCodes.TelemetryResponse, onPush);
          resolve(response);
        };
        connection.on(Constants.PushCodes.TelemetryResponse, onPush);
        // tidy the listener if the queue times this command out
        setTimeout(
          () => connection.off(Constants.PushCodes.TelemetryResponse, onPush),
          30000,
        ).unref?.();
        connection.sendToRadioFrame(
          Uint8Array.from([Constants.CommandCodes.SendTelemetryReq, 0, 0, 0]),
        ).catch((err) => {
          connection.off(Constants.PushCodes.TelemetryResponse, onPush);
          reject(err);
        });
      }),
      'getSelfTelemetry',
    ),
    sendText: (text, to) => sendDm(text, to, 0),
    sendChannelText: (text, channelIdx) => {
      note(`ch${channelIdx}`, text);
      return queue.run(
        () => connection.sendChannelTextMessage(channelIdx, clamp(text)),
        'sendChannelText',
      );
    },
  };
}

module.exports = { makeDevice, clamp, MAX_TEXT };
