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
    sendText: (text, to) => {
      note('dm', text);
      return queue.run(
        () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
        'sendText',
      );
    },
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
