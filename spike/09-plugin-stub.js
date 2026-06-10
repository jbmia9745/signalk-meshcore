/* eslint-disable no-console */
// Spike 9 (Phase 3 exit test): run the REAL plugin against the REAL radio
// with a stubbed Signal K app. Synthetic VESSEL deltas feed the
// telemetry instance, so from the phone this is the finished product:
//   - telemetry line lands in SK-TEST every minute
//   - DM verbs work: ping, wx, batt, pos, depth, status, help
//   - "turn decklight on" works once SK-DEV2 is in node-db.json (2nd run)
//
// Usage: node spike/09-plugin-stub.js <serial device path> [minutes]

const { mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const serialPath = process.argv[2];
const minutes = parseInt(process.argv[3], 10) || 10;
if (!serialPath) {
  console.error('Usage: node spike/09-plugin-stub.js <serial device path> [minutes]');
  process.exit(1);
}

const dataDir = join(__dirname, 'spike-data');
mkdirSync(dataDir, { recursive: true });

// If a previous run stored SK-DEV2 in the node DB, promote it to crew so
// crew-only commands (switching) can be tested.
function crewFromNodeDb() {
  try {
    const db = JSON.parse(readFileSync(join(dataDir, 'node-db.json'), 'utf-8'));
    return Object.keys(db)
      .filter((key) => db[key].name === 'SK-DEV2')
      .map((key) => ({ publicKey: key, role: 'crew' }));
  } catch (e) {
    return [];
  }
}

const settings = {
  device: { transport: 'serial', address: serialPath },
  nodes: crewFromNodeDb(),
  communications: {
    send_position: false,
    send_alerts: true,
    digital_switching: true,
    populate_vessels: true,
  },
  telemetry: {
    enabled: true,
    channelName: 'SK-TEST',
    intervalMinutes: 1,
    vesselName: 'VESSEL',
    windSource: 'true',
  },
  switches: [{ name: 'decklight', path: 'electrical.switches.bank.0.4.state' }],
};

console.log(`Crew from node DB: ${settings.nodes.length ? settings.nodes[0].publicKey.slice(0, 12) : '(none yet — switching disabled this run)'}`);

let deltaCallback;
const app = {
  setPluginStatus: (s) => console.log(`[status] ${s}`),
  setPluginError: (s) => console.log(`[ERROR ] ${s}`),
  debug: (s) => console.log(`[debug ] ${s}`),
  error: (s) => console.log(`[error ] ${s}`),
  getDataDirPath: () => dataDir,
  getSelfPath: () => 'VESSEL',
  handleMessage: (id, delta) => {
    const v = delta.updates[0].values
      .map((val) => `${val.path || 'meta'}=${JSON.stringify(val.value)}`)
      .join(' ');
    console.log(`[deltaOut] ${delta.context}: ${v}`);
  },
  putSelfPath: (path, value, cb) => {
    console.log(`[PUT] ${path} = ${value}`);
    cb({ state: 'COMPLETED', statusCode: 200 });
  },
  subscriptionmanager: {
    subscribe: (def, unsubs, errCb, cb) => {
      console.log(`[subscribe] ${def.subscribe.length} paths`);
      deltaCallback = cb;
      unsubs.push(() => { deltaCallback = null; });
    },
  },
  signalk: { root: { vessels: {} } },
};

const plugin = require('../plugin/index')(app);

function restart(s) {
  console.log('[restart requested]');
  plugin.stop();
  setTimeout(() => plugin.start(s, restart), 2000);
}

plugin.start(settings, restart);

// Feed the VESSEL live-dump values as Signal K deltas every 10s,
// with a little jitter so successive telemetry lines differ.
const feed = setInterval(() => {
  if (!deltaCallback) {
    return;
  }
  const j = (base, span) => base + ((Math.random() - 0.5) * span);
  deltaCallback({
    updates: [{
      values: [
        { path: 'environment.outside.temperature', value: j(304.67, 0.6) },
        { path: 'environment.outside.relativeHumidity', value: j(0.6707, 0.01) },
        { path: 'environment.outside.pressure', value: j(101928, 40) },
        { path: 'environment.wind.directionTrue', value: j(0.506, 0.1) },
        // occasional gust well above the 2 kn threshold
        {
          path: 'environment.wind.speedOverGround',
          value: Math.random() < 0.25 ? j(9.5, 1) : j(5.29, 1.5),
        },
        { path: 'electrical.batteries.house.voltage', value: j(13.29, 0.05) },
        { path: 'electrical.batteries.house.current', value: j(-6.4, 0.8) },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.985 },
        { path: 'environment.depth.belowSurface', value: j(4.384, 0.3) },
        { path: 'navigation.position', value: { latitude: 38.97, longitude: -76.48 } },
      ],
    }],
  });
}, 10000);

setTimeout(() => {
  clearInterval(feed);
  plugin.stop();
  console.log('Done');
  process.exit(0);
}, minutes * 60000);
