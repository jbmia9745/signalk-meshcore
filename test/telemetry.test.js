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
    'VESSEL | 88.7F | 67%RH | 1019mb | NE 10.3k | Depth 14.4FT | SOC 99% 13.3V -6.4A',
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
  assert.strictEqual(t.segments().wind, '29S 10.3k');
  // with heading (magnetic + variation): 63.4°M − 7.0° = 56.4°T; +29° = 85.4° → E
  t.update('navigation.headingMagnetic', 1.1069);
  t.update('navigation.magneticVariation', -0.1223);
  assert.strictEqual(t.segments().wind, '29S(E) 10.3k');
  // headingTrue wins over magnetic when present (due W puts wind at WNW→NW)
  t.update('navigation.headingTrue', (270 / 180) * Math.PI);
  assert.strictEqual(t.segments().wind, '29S(NW) 10.3k');
});

test('wind renders with only one of direction/speed available', () => {
  const t = new Telemetry();
  t.update('environment.wind.directionTrue', Math.PI); // S
  assert.strictEqual(t.segments().wind, 'S');
  t.update('environment.wind.speedOverGround', 5.29);
  assert.strictEqual(t.segments().wind, 'S 10.3k');
});

test('wind is WMO: 10-min mean, gust = max 3-sample average, shown when meaningful', () => {
  const t = new Telemetry();
  const now = Date.now();
  // 1 Hz samples: steady ~5.3 m/s with a 3-sample squall at 9 m/s
  const samples = [5.3, 5.3, 5.3, 5.3, 9.0, 9.0, 9.0, 5.3, 5.3, 5.3];
  samples.forEach((v, i) => t.update('environment.wind.speedOverGround', v, now - (samples.length - i) * 1000));
  const sustainedKn = ((5.3 * 7 + 9.0 * 3) / 10) * 1.94384; // mean of the window
  const gustKn = 9.0 * 1.94384; // best 3-sample average = the squall
  const expected = `${sustainedKn.toFixed(1)}k gusts ${Math.round(gustKn)}k`;
  assert.strictEqual(t.segments().wind, expected);
  // reads are non-destructive
  assert.strictEqual(t.segments().wind, expected);
  // a single 1-second spike is NOT a WMO gust: the 3-sample average
  // dilutes it below the display threshold (raw max would have shown)
  const spiky = new Telemetry();
  const spikySamples = Array(20).fill(5.0);
  spikySamples[10] = 8.0;
  spikySamples.forEach((v, i) => spiky.update('environment.wind.speedOverGround', v, now - (20 - i) * 1000));
  assert.ok(!spiky.segments().wind.includes('gusts'), `spike should dilute: ${spiky.segments().wind}`);
  // steady wind → no gust shown
  const steady = new Telemetry();
  [5.29, 5.3, 5.2].forEach((v, i) => steady.update('environment.wind.speedOverGround', v, now - (3 - i) * 1000));
  assert.ok(!steady.segments().wind.includes('gusts'));
});

test('wind samples older than 10 minutes fall out of the window', () => {
  const t = new Telemetry();
  const now = Date.now();
  // a gale 11 minutes ago must not influence the current reading
  t.update('environment.wind.speedOverGround', 25.0, now - 11 * 60000);
  t.update('environment.wind.speedOverGround', 5.0, now - 2000);
  t.update('environment.wind.speedOverGround', 5.0, now - 1000);
  assert.strictEqual(t.segments().wind, `${(5.0 * 1.94384).toFixed(1)}k`);
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

test('null-island positions are rejected', () => {
  const t = new Telemetry();
  t.update('navigation.position', { latitude: -1e-16, longitude: -1e-16 });
  assert.strictEqual(t.position, null);
  t.update('navigation.position', { latitude: 25.724, longitude: -80.158 });
  t.update('navigation.position', { latitude: -1e-7, longitude: -1e-7 });
  assert.deepStrictEqual(t.position, { latitude: 25.724, longitude: -80.158 });
});
