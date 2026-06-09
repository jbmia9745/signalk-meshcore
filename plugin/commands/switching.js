// Digital switching: "turn <name> on|off".
//
// Real-world switch paths vary (VESSEL uses N2K bank paths like
// electrical.switches.bank.0.4.state), so names map to full paths via
// settings.switches: [{ name, path }]. When no mapping exists for a
// name, falls back to the simple template electrical.switches.<name>.state.
const PATTERN = /^turn ([a-z0-9]+) (on|off)$/i;

function resolvePath(name, settings) {
  const mapped = (settings.switches || [])
    .find((sw) => sw.name && sw.name.toLowerCase() === name.toLowerCase());
  if (mapped && mapped.path) {
    return mapped.path;
  }
  return `electrical.switches.${name}.state`;
}

module.exports = {
  crewOnly: true,
  example: 'Turn <switch name> on',
  accept: (msg, settings) => {
    if (!settings.communications || !settings.communications.digital_switching) {
      return false;
    }
    return PATTERN.test(msg.data.trim());
  },
  handle: (msg, settings, device, app) => {
    const switching = msg.data.trim().match(PATTERN);
    const name = switching[1];
    const value = switching[2].toLowerCase() === 'on';
    const path = resolvePath(name, settings);
    return new Promise((resolve, reject) => {
      app.putSelfPath(path, value, (res) => {
        if (res.state !== 'COMPLETED') {
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(res.message));
          return;
        }
        resolve();
      });
    })
      .then(() => device.sendText(`OK, ${name} is ${switching[2].toLowerCase()}`, msg.from));
  },
};
