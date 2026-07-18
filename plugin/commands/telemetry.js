// Telemetry pull verbs, each with a short alias:
//   wx/w | batt/b | pos/ps | depth/d | status/s
const ALIASES = {
  wx: 'wx',
  w: 'wx',
  batt: 'batt',
  b: 'batt',
  pos: 'pos',
  ps: 'pos',
  depth: 'depth',
  d: 'depth',
  status: 'status',
  s: 'status',
};

module.exports = {
  crewOnly: false,
  example: 'WX/W | Batt/B | Pos/Ps | Depth/D | Status/S',
  accept: (msg) => Object.prototype.hasOwnProperty.call(ALIASES, msg.data.trim().toLowerCase()),
  handle: (msg, settings, device, app, telemetry) => {
    const verb = ALIASES[msg.data.trim().toLowerCase()];
    const s = telemetry.segments();
    const join = (keys) => telemetry.constructor.joinSegments(s, keys);
    let reply;
    switch (verb) {
      case 'wx':
        reply = join(['temp', 'humidity', 'pressure', 'wind']) || 'No wx data';
        break;
      case 'batt':
        reply = join(['batt']) || 'No batt data';
        break;
      case 'depth':
        reply = join(['depth']) || 'No depth data';
        break;
      case 'pos': {
        const p = telemetry.position;
        reply = (p && Number.isFinite(p.latitude))
          ? `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`
          : 'No position';
        break;
      }
      case 'status':
      default: {
        // honor the same include-vessel-name setting as the channel push
        const t = settings.telemetry || {};
        const includeName = t.includeVesselName !== false;
        const name = includeName
          ? (t.vesselName || (app && app.getSelfPath && app.getSelfPath('name')))
          : undefined;
        reply = telemetry.buildLine(name) || 'No telemetry';
      }
    }
    return device.sendText(reply, msg.from);
  },
};
