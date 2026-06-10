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
    'VESSEL | 88.7F | 67%RH | 1019mb | NE 10.3K | Depth 14.4FT | SOC 99% 13.3V -6.4A',
  );
});

test('charging current gets an explicit plus sign', () => {
  const t = new Telemetry();
  t.update('electrical.batteries.house.current', 12.3);
  assert.strictEqual(t.segments().batt, '+12.3A');
});

test('apparent wind renders bow angle, plus compass point when heading known', () => {
  const t = new Telemetry({ windSource: 'apparent' });
  t.update('environment.wind.angleApparent', 0.506); // ≈ 29° starboard
  t.update('environment.wind.speedApparent', 5.29);
  // true-wind paths must be ignored in apparent mode
  t.update('environment.wind.directionTrue', 1.0);
  assert.strictEqual(t.segments().wind, '29S 10.3K');
  // with heading (magnetic + variation): 63.4°M − 7.0° = 56.4°T; +29° = 85.4° → E
  t.update('navigation.headingMagnetic', 1.1069);
  t.update('navigation.magneticVariation', -0.1223);
  assert.strictEqual(t.segments().wind, '29S(E) 10.3K');
  // headingTrue wins over magnetic when present (due W puts wind at WNW→NW)
  t.update('navigation.headingTrue', (270 / 180) * Math.PI);
  assert.strictEqual(t.segments().wind, '29S(NW) 10.3K');
});

test('wind renders with only one of direction/speed available', () => {
  const t = new Telemetry();
  t.update('environment.wind.directionTrue', Math.PI); // S
  assert.strictEqual(t.segments().wind, 'S');
  t.update('environment.wind.speedOverGround', 5.29);
  assert.strictEqual(t.segments().wind, 'S 10.3K');
});

test('gusts appear when max meaningfully exceeds the median', () => {
  const t = new Telemetry();
  // median 5.29 m/s ≈ 10.3 kn; gust 9 m/s ≈ 17.5 kn
  [5.29, 5.1, 9.0].forEach((v) => t.update('environment.wind.speedOverGround', v));
  assert.strictEqual(t.segments().wind, '10.3K G17.5K');
  t.update('environment.wind.directionTrue', 0.506);
  assert.strictEqual(t.segments().wind, 'NE 10.3K G17.5K');
  // steady wind → no gust shown
  const steady = new Telemetry();
  [5.29, 5.3, 5.2].forEach((v) => steady.update('environment.wind.speedOverGround', v));
  assert.strictEqual(steady.segments().wind, '10.3K');
});

test('wind speed accumulates and reads as median, non-destructively', () => {
  const t = new Telemetry();
  [2, 10, 4].forEach((v) => t.update('environment.wind.speedOverGround', v));
  const expected = `${(4 * 1.94384).toFixed(1)}K G${(10 * 1.94384).toFixed(1)}K`;
  assert.strictEqual(t.segments().wind, expected);
  // second read still works (read does not clear)
  assert.strictEqual(t.segments().wind, expected);
  t.clearWindHistory();
  assert.strictEqual(t.segments().wind, undefined);
});

test('anchor distance joins the depth segment when anchored', () => {
  const t = new Telemetry();
  t.update('environment.depth.belowSurface', 4.384);
  t.update('navigation.anchor.distanceFromBow', 30);
  assert.strictEqual(t.segments().depth, 'Depth 14.4FT Dist 98FT');
  t.update('electrical.batteries.house.voltage', 13.29);
  assert.strictEqual(t.buildLine(), 'Depth 14.4FT Dist 98FT | 13.3V');
});

test('anchor distance renders alone when depth is unavailable', () => {
  const t = new Telemetry();
  t.update('navigation.anchor.distanceFromBow', 30);
  assert.strictEqual(t.segments().depth, 'Dist 98FT');
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
  assert.strictEqual(t.buildLine(), '88.7F');
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
