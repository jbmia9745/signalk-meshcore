// Telemetry pull verbs: wx | batt | pos | depth | status
const VERBS = ['wx', 'batt', 'pos', 'depth', 'status'];

module.exports = {
  crewOnly: false,
  example: 'WX | Batt | Pos | Depth | Status',
  accept: (msg) => VERBS.includes(msg.data.trim().toLowerCase()),
  handle: (msg, settings, device, app, telemetry) => {
    const verb = msg.data.trim().toLowerCase();
    const s = telemetry.segments();
    const join = (keys) => telemetry.constructor.joinSegments(s, keys);
    let reply;
    switch (verb) {
      case 'wx':
        reply = join(['temp', 'humidity', 'pressure', 'wind']) || 'No wx data';
        break;
      case 'batt':
        reply = join(['voltage', 'current', 'soc']) || 'No batt data';
        break;
      case 'depth':
        reply = join(['depth', 'anchor']) || 'No depth data';
        break;
      case 'pos': {
        const p = telemetry.position;
        reply = (p && Number.isFinite(p.latitude))
          ? `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`
          : 'No position';
        break;
      }
      case 'status':
      default:
        reply = telemetry.buildLine((settings.telemetry || {}).vesselName) || 'No telemetry';
    }
    return device.sendText(reply, msg.from);
  },
};
