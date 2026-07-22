const { test } = require('node:test');
const assert = require('node:assert');
const plugin = require('../plugin/index');

// The subscription path list is what the plugin sends to the Signal K server
// on connect. A single undefined/malformed path throws synchronously inside
// onConnected, which closes the radio connection and loops it (field incident
// 2026-07-18: a refactor removed telemetry.wind but left a subscriber reading
// it, so a path was undefined -> connect/disconnect loop, ~1/sec). The other
// unit tests mock the subscription manager away, so this drives the real
// list-builder directly.

const { buildSubscriptions, sensorTempPaths } = plugin;

test('every subscribed path is a defined, non-empty string', () => {
  const subs = buildSubscriptions({});
  assert.ok(Array.isArray(subs) && subs.length > 10, 'subscription list built');
  subs.forEach((s, i) => {
    assert.strictEqual(typeof s.path, 'string', `sub[${i}].path must be a string, got ${JSON.stringify(s.path)}`);
    assert.ok(s.path.length > 0, `sub[${i}].path must be non-empty`);
  });
});

test('subscription list includes the apparent-wind inputs (computed true wind needs them)', () => {
  const paths = buildSubscriptions({}).map((s) => s.path);
  assert.ok(paths.includes('environment.wind.angleApparent'));
  assert.ok(paths.includes('environment.wind.speedApparent'));
  assert.ok(paths.includes('navigation.speedThroughWater'));
  assert.ok(paths.includes('navigation.headingMagnetic'));
});

test('subscription list includes configured sensor temperature paths', () => {
  const paths = buildSubscriptions({}).map((s) => s.path);
  // defaults
  assert.ok(paths.includes('environment.inside.refrigerator.temperature'), 'fridge');
  assert.ok(paths.includes('environment.venus.25.temperature'), 'cabin');
  assert.ok(paths.includes('environment.venus.20.temperature'), 'battery temp');
});

test('custom sensor config flows into the subscription list', () => {
  const settings = {
    sensors: {
      fridge_temp_path: 'environment.custom.fridge',
      battery_temps: [{ path: 'environment.custom.batt', label: 'X' }],
    },
  };
  const paths = buildSubscriptions(settings).map((s) => s.path);
  assert.ok(paths.includes('environment.custom.fridge'));
  assert.ok(paths.includes('environment.custom.batt'));
});

test('sensorTempPaths returns only defined strings for default and custom config', () => {
  [{}, { sensors: { battery_temps: [{ path: 'a.b' }] } }].forEach((s) => {
    sensorTempPaths(s).forEach((p) => {
      assert.strictEqual(typeof p, 'string');
      assert.ok(p.length > 0);
    });
  });
});

const { computeSetupWarnings } = plugin;

test('a fully-configured install produces NO setup warnings (no false positives)', () => {
  // Mirrors the live boat config: channel under settings.telemetry (not
  // communications), a crew node, wind data present. Must be silent.
  const settings = {
    telemetry: { enabled: true, channelName: 'Vessel_Comm' },
    nodes: [{ publicKey: 'abc', role: 'crew' }],
  };
  const data = {
    'environment.wind.angleApparent': 0.1,
    'environment.wind.speedApparent': [{ t: 1, v: 5 }],
  };
  assert.deepStrictEqual(computeSetupWarnings(settings, { telemetryData: data }), []);
});

test('setup warnings flag a missing telemetry channel', () => {
  const w = computeSetupWarnings({ telemetry: { enabled: true }, nodes: [{ role: 'crew' }] });
  assert.ok(w.some((x) => x.includes('no telemetry channel')));
});

test('setup warnings flag no crew assigned', () => {
  const w = computeSetupWarnings({ telemetry: { channelName: 'C' }, nodes: [] });
  assert.ok(w.some((x) => x.includes('no crew')));
});

test('setup warnings flag missing wind data when telemetry data has none', () => {
  const w = computeSetupWarnings(
    { telemetry: { channelName: 'C' }, nodes: [{ role: 'crew' }] },
    { telemetryData: {} },
  );
  assert.ok(w.some((x) => x.includes('no wind data')));
});

test('setup warnings do not check wind when telemetry push is disabled', () => {
  const w = computeSetupWarnings(
    { telemetry: { enabled: false }, nodes: [{ role: 'crew' }] },
    { telemetryData: {} },
  );
  assert.ok(!w.some((x) => x.includes('wind')));
  assert.ok(!w.some((x) => x.includes('channel'))); // push off → channel not required
});

test('plugin factory builds and exposes start/stop/schema', () => {
  const app = {
    debug() {},
    error() {},
    setPluginStatus() {},
    setPluginError() {},
    getSelfPath() { return 'V'; },
    getDataDirPath() { return '/tmp'; },
    handleMessage() {},
    subscriptionmanager: { subscribe() {} },
  };
  const p = plugin(app);
  assert.strictEqual(typeof p.start, 'function');
  assert.strictEqual(typeof p.stop, 'function');
  assert.ok(p.schema().properties.sensors);
});
