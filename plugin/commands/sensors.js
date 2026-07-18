// Extra temperature sensor verbs: fridge (f) | cabin (c). Reads the
// configured sensor paths off the Telemetry store (fed by the plugin's
// subscription), so an unconfigured or not-yet-seen sensor replies "No data"
// rather than erroring.
const FRIDGE = ['fridge', 'f'];
const CABIN = ['cabin', 'c'];
const VERBS = [...FRIDGE, ...CABIN];

module.exports = {
  crewOnly: false,
  example: 'F(ridge) | C(abin)',
  accept: (msg) => VERBS.includes(msg.data.trim().toLowerCase()),
  handle: (msg, settings, device, app, telemetry) => {
    const verb = msg.data.trim().toLowerCase();
    let reply;
    if (FRIDGE.includes(verb)) {
      const f = telemetry.tempF(telemetry.fridgeTempPath);
      reply = f !== null ? `Fridge ${f.toFixed(1)}F` : 'No fridge data';
    } else {
      const f = telemetry.tempF(telemetry.cabinTempPath);
      reply = f !== null ? `Cabin ${f.toFixed(1)}F` : 'No cabin data';
    }
    return device.sendText(reply, msg.from);
  },
};
