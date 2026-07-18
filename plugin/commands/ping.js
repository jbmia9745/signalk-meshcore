const VERBS = ['ping', 'p'];

module.exports = {
  crewOnly: false,
  example: 'Ping/P',
  accept: (msg) => VERBS.includes(msg.data.trim().toLowerCase()),
  handle: (msg, settings, device) => device.sendText('Pong', msg.from),
};
