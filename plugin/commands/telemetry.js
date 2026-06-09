// Telemetry pull verbs: wx | batt | pos | depth | status
const VERBS = ['wx', 'batt', 'pos', 'depth', 'status'];

function fmt(fields, keys) {
  return keys
    .filter((k) => fields[k] !== undefined)
    .map((k) => `${k}${fields[k]}`)
    .join(' ');
}

module.exports = {
  crewOnly: false,
  example: 'WX | Batt | Pos | Depth | Status',
  accept: (msg) => VERBS.includes(msg.data.trim().toLowerCase()),
  handle: (msg, settings, device, app, telemetry) => {
    const verb = msg.data.trim().toLowerCase();
    const f = telemetry.toImperial();
    let reply;
    switch (verb) {
      case 'wx':
        reply = fmt(f, ['T', 'H', 'P', telemetry.wind.directionLabel, telemetry.wind.speedLabel])
          || 'No wx data';
        break;
      case 'batt':
        reply = fmt(f, ['Vb', 'Ib', 'SoC']) || 'No batt data';
        break;
      case 'depth':
        if (f.Anc !== undefined) {
          reply = `Anc${f.Anc}`;
        } else if (f.D !== undefined) {
          reply = `D${f.D}`;
        } else {
          reply = 'No depth data';
        }
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
