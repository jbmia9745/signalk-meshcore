exports.ping = require('./ping');
exports.switching = require('./switching');
exports.telemetry = require('./telemetry');

// Crew membership is keyed on the contact public key (hex string in
// settings; msg.from is the raw Uint8Array from the contact DB).
exports.isFromCrew = (msg, settings) => {
  if (!settings.nodes || !settings.nodes.length || !msg.from) {
    return false;
  }
  const fromHex = Buffer.from(msg.from).toString('hex').toLowerCase();
  return settings.nodes.some((node) => node.role === 'crew'
    && node.publicKey
    && node.publicKey.toLowerCase() === fromHex);
};

exports.help = {
  crewOnly: false,
  example: 'Help',
  accept: (msg) => (msg.data.trim().toLowerCase() === 'help'),
  handle: (msg, settings, device) => {
    const commands = Object.keys(exports)
      .filter((cmd) => {
        if (cmd === 'isFromCrew') {
          return false;
        }
        if (!exports.isFromCrew(msg, settings) && exports[cmd].crewOnly) {
          return false;
        }
        return true;
      })
      .map((cmd) => exports[cmd].example);
    return device.sendText(`Commands: ${commands.join(', ')}`, msg.from);
  },
};
