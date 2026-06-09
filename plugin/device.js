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

function makeDevice(connection, Constants, queue) {
  return {
    maxTextLength: MAX_TEXT,
    sendText: (text, to) => queue.run(
      () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
      'sendText',
    ),
    sendChannelText: (text, channelIdx) => queue.run(
      () => connection.sendChannelTextMessage(channelIdx, clamp(text)),
      'sendChannelText',
    ),
  };
}

module.exports = { makeDevice, clamp, MAX_TEXT };
