// Run: node --test extras/sk-depth-sanity/test.js
const { test } = require('node:test');
const assert = require('node:assert');

const mkApp = () => ({
  debug() {}, setPluginStatus() {}, registerDeltaInputHandler() {},
});
const factory = require('./index');

test('field incident 2026-07-26: sentinel values nulled, sane values untouched', () => {
  const f = factory(mkApp()).filterDelta;
  const d = {
    updates: [{
      values: [
        { path: 'environment.depth.belowTransducer', value: 42949672.92 },
        { path: 'environment.depth.belowSurface', value: 42949673.224 },
        { path: 'environment.depth.surfaceToTransducer', value: 0.304 },
      ],
    }],
  };
  assert.strictEqual(f(d, 1000), 2);
  assert.strictEqual(d.updates[0].values[0].value, null);
  assert.strictEqual(d.updates[0].values[1].value, null);
  assert.strictEqual(d.updates[0].values[2].value, 0.304);
});

test('normal depth readings pass through', () => {
  const f = factory(mkApp()).filterDelta;
  const d = { updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: 3.1 }] }] };
  assert.strictEqual(f(d, 1000), 0);
  assert.strictEqual(d.updates[0].values[0].value, 3.1);
});

test('non-depth paths are never touched, however large', () => {
  const f = factory(mkApp()).filterDelta;
  const d = {
    updates: [{
      values: [
        { path: 'environment.wind.speedApparent', value: 99999999 },
        { path: 'navigation.position', value: { latitude: 25.7, longitude: -80.2 } },
      ],
    }],
  };
  assert.strictEqual(f(d, 1000), 0);
  assert.strictEqual(d.updates[0].values[0].value, 99999999);
});

test('malformed deltas do not throw', () => {
  const f = factory(mkApp()).filterDelta;
  assert.strictEqual(f({}, 1000), 0);
  assert.strictEqual(f(null, 1000), 0);
  assert.strictEqual(f({ updates: [{ meta: [{ path: 'x' }] }] }, 1000), 0);
  assert.strictEqual(f({ updates: [{ values: [{ path: 'environment.depth.belowTransducer' }] }] }, 1000), 0);
  assert.strictEqual(f({ updates: [{ values: [null] }] }, 1000), 0);
  assert.strictEqual(f({ updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: null }] }] }, 1000), 0);
});

test('lifecycle: start registers and filters, stop reverts to passthrough', () => {
  let status = '';
  let handler = null;
  const app = {
    debug() {},
    setPluginStatus(s) { status = s; },
    registerDeltaInputHandler(h) { handler = h; },
  };
  const p = factory(app);
  p.start({ maxDepthMeters: 500 });
  assert.ok(status.includes('500'));
  assert.strictEqual(typeof handler, 'function');

  const active = { updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: 42949672.92 }] }] };
  let passed = null;
  handler(active, (x) => { passed = x; });
  assert.strictEqual(passed.updates[0].values[0].value, null);

  p.stop();
  const stopped = { updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: 42949672.92 }] }] };
  handler(stopped, () => {});
  assert.strictEqual(stopped.updates[0].values[0].value, 42949672.92);
});
