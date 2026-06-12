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

function makeDevice(connection, Constants, queue, log) {
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

  const DM_RETRIES = 1;
  const RETRY_GAP_MS = 2000;

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
        : null,
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
