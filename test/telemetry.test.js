const { test } = require('node:test');
const assert = require('node:assert');
const Telemetry = require('../plugin/telemetry');

// Values from the VESSEL live dump (spec §5)
function feedVessel(t) {
  t.update('environment.outside.temperature', 304.67);
  t.update('environment.outside.relativeHumidity', 0.6707);
  t.update('environment.outside.pressure', 101928);
  t.update('electrical.batteries.house.voltage', 13.29);
  t.update('electrical.batteries.house.current', -6.4);
  t.update('electrical.batteries.house.capacity.stateOfCharge', 0.985);
  t.update('environment.depth.belowSurface', 4.384);
}

test('buildLine matches the spec example with true wind', () => {
  const t = new Telemetry({ windSource: 'true' });
  feedVessel(t);
  t.update('environment.wind.directionTrue', 0.506);
  t.update('environment.wind.speedOverGround', 5.29);
  assert.strictEqual(
    t.buildLine('VESSEL'),
    'VESSEL T89 H67 P1019 WdNE Ws10.3 Vb13.3 SoC99 Ib-6.4 D14',
  );
});

test('apparent wind source relabels and renders bow angle', () => {
  const t = new Telemetry({ windSource: 'apparent' });
  t.update('environment.wind.angleApparent', 0.506); // ≈ 29° starboard
  t.update('environment.wind.speedApparent', 5.29);
  // true-wind paths must be ignored in apparent mode
  t.update('environment.wind.directionTrue', 1.0);
  const f = t.toImperial();
  assert.strictEqual(f.Wa, '29S');
  assert.strictEqual(f.Wsa, '10.3');
  assert.strictEqual(f.Wd, undefined);
  assert.strictEqual(f.Ws, undefined);
});

test('wind speed accumulates and reads as median, non-destructively', () => {
  const t = new Telemetry();
  [2, 10, 4].forEach((v) => t.update('environment.wind.speedOverGround', v));
  assert.strictEqual(t.toImperial().Ws, (4 * 1.94384).toFixed(1));
  // second read still works (read does not clear)
  assert.strictEqual(t.toImperial().Ws, (4 * 1.94384).toFixed(1));
  t.clearWindHistory();
  assert.strictEqual(t.toImperial().Ws, undefined);
});

test('anchor distance takes precedence over depth', () => {
  const t = new Telemetry();
  t.update('environment.depth.belowSurface', 4.384);
  t.update('navigation.anchor.distanceFromBow', 30);
  const f = t.toImperial();
  assert.strictEqual(f.Anc, 98);
  assert.strictEqual(f.D, undefined);
});

test('position is stored, null-island and non-finite rejected', () => {
  const t = new Telemetry();
  t.update('navigation.position', { latitude: 38.97, longitude: -76.48 });
  assert.deepStrictEqual(t.position, { latitude: 38.97, longitude: -76.48 });
  t.update('navigation.position', { latitude: NaN, longitude: 1 });
  assert.deepStrictEqual(t.position, { latitude: 38.97, longitude: -76.48 });
  t.update('navigation.position', null);
  assert.deepStrictEqual(t.position, { latitude: 38.97, longitude: -76.48 });
});

test('buildLine returns null with no data, omits name when not given', () => {
  const t = new Telemetry();
  assert.strictEqual(t.buildLine('VESSEL'), null);
  t.update('environment.outside.temperature', 304.67);
  assert.strictEqual(t.buildLine(), 'T89');
});
