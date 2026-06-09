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

test('buildLine renders the human pipe-delimited format', () => {
  const t = new Telemetry({ windSource: 'true' });
  feedVessel(t);
  t.update('environment.wind.directionTrue', 0.506);
  t.update('environment.wind.speedOverGround', 5.29);
  assert.strictEqual(
    t.buildLine('VESSEL'),
    'VESSEL | 89F | 67% | 1019mb | NE@10.3k | dpt 14ft | 99%soc | 13.3v | -6.4a',
  );
});

test('charging current gets an explicit plus sign', () => {
  const t = new Telemetry();
  t.update('electrical.batteries.house.current', 12.3);
  assert.strictEqual(t.segments().current, '+12.3a');
});

test('apparent wind is marked and rendered as bow angle', () => {
  const t = new Telemetry({ windSource: 'apparent' });
  t.update('environment.wind.angleApparent', 0.506); // ≈ 29° starboard
  t.update('environment.wind.speedApparent', 5.29);
  // true-wind paths must be ignored in apparent mode
  t.update('environment.wind.directionTrue', 1.0);
  assert.strictEqual(t.segments().wind, '29S@10.3k(A)');
});

test('wind renders with only one of direction/speed available', () => {
  const t = new Telemetry();
  t.update('environment.wind.directionTrue', Math.PI); // S
  assert.strictEqual(t.segments().wind, 'S wind');
  t.update('environment.wind.speedOverGround', 5.29);
  assert.strictEqual(t.segments().wind, 'S@10.3k');
});

test('gusts appear when max meaningfully exceeds the median', () => {
  const t = new Telemetry();
  // median 5.29 m/s ≈ 10.3 kn; gust 9 m/s ≈ 17.5 kn
  [5.29, 5.1, 9.0].forEach((v) => t.update('environment.wind.speedOverGround', v));
  assert.strictEqual(t.segments().wind, '10.3k g17.5 wind');
  t.update('environment.wind.directionTrue', 0.506);
  assert.strictEqual(t.segments().wind, 'NE@10.3k g17.5');
  // steady wind → no gust shown
  const steady = new Telemetry();
  [5.29, 5.3, 5.2].forEach((v) => steady.update('environment.wind.speedOverGround', v));
  assert.strictEqual(steady.segments().wind, '10.3k wind');
});

test('wind speed accumulates and reads as median, non-destructively', () => {
  const t = new Telemetry();
  [2, 10, 4].forEach((v) => t.update('environment.wind.speedOverGround', v));
  const expected = `${(4 * 1.94384).toFixed(1)}k g${(10 * 1.94384).toFixed(1)} wind`;
  assert.strictEqual(t.segments().wind, expected);
  // second read still works (read does not clear)
  assert.strictEqual(t.segments().wind, expected);
  t.clearWindHistory();
  assert.strictEqual(t.segments().wind, undefined);
});

test('depth and anchor distance are separate segments', () => {
  const t = new Telemetry();
  t.update('environment.depth.belowSurface', 4.384);
  t.update('navigation.anchor.distanceFromBow', 30);
  const s = t.segments();
  assert.strictEqual(s.depth, 'dpt 14ft');
  assert.strictEqual(s.anchor, 'anc 98ft');
  t.update('electrical.batteries.house.voltage', 13.29);
  assert.strictEqual(t.buildLine(), 'dpt 14ft | anc 98ft | 13.3v');
});

test('position is stored, non-finite rejected', () => {
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
  assert.strictEqual(t.buildLine(), '89F');
});

test('full line stays within the 133-char send cap', () => {
  const t = new Telemetry();
  feedVessel(t);
  t.update('environment.wind.directionTrue', 0.506);
  t.update('environment.wind.speedOverGround', 5.29);
  t.update('navigation.anchor.distanceFromBow', 123.4);
  const line = t.buildLine('A-LONGISH-VESSEL-NAME');
  assert.ok(line.length <= 133, `line too long: ${line.length}`);
});
