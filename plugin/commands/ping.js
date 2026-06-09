module.exports = {
  crewOnly: false,
  example: 'Ping',
  accept: (msg) => (msg.data.trim().toLowerCase() === 'ping'),
  handle: (msg, settings, device) => device.sendText('Pong', msg.from),
};
