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
  const t = new Telemetry();
  feedVessel(t);
  // at rest (no boat speed): apparent IS true. Apparent 0.506 rad off a bow
  // heading of due-N (0) places true wind at ~29 deg -> NNE, rounds to NE.
  t.update('environment.wind.angleApparent', 0.506);
  t.update('environment.wind.speedApparent', 5.29);
  t.update('navigation.headingTrue', 0);
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

test('at rest, true wind is a compass point placed by heading', () => {
  const now = Date.now();
  const t = new Telemetry();
  // apparent 29 deg starboard, at rest (apparent==true)
  t.update('environment.wind.angleApparent', 0.506);
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 5.29, now - (3 - i) * 1000);
  }
  // heading magnetic 63.4 + variation -7 = 56.4 T; +29 apparent = 85.4 -> E
  t.update('navigation.headingMagnetic', 1.1069);
  t.update('navigation.magneticVariation', -0.1223);
  assert.strictEqual(t.segments().wind, 'E 10.3k');
  // headingTrue wins over magnetic when present (due W: 270 + 29 = 299 -> WNW->NW)
  t.update('navigation.headingTrue', (270 / 180) * Math.PI);
  assert.strictEqual(t.segments().wind, 'NW 10.3k');
});

// Wind now always renders a true compass point, which needs a heading and an
// apparent angle. These tests set both so the speed-smoothing (WMO) logic can
// be exercised; at rest the true speed equals the apparent speed.
function feedWindContext(t) {
  t.update('environment.wind.angleApparent', 0); // dead ahead
  t.update('navigation.headingTrue', 0); // due N -> point N
}

test('wind is WMO: 10-min mean, gust = max 3-sample average, shown when meaningful', () => {
  const t = new Telemetry();
  feedWindContext(t);
  const now = Date.now();
  // 1 Hz samples: steady ~5.3 m/s with a 3-sample squall at 9 m/s
  const samples = [5.3, 5.3, 5.3, 5.3, 9.0, 9.0, 9.0, 5.3, 5.3, 5.3];
  samples.forEach((v, i) => t.update('environment.wind.speedApparent', v, now - (samples.length - i) * 1000));
  const sustainedKn = ((5.3 * 7 + 9.0 * 3) / 10) * 1.94384; // mean of the window
  const gustKn = 9.0 * 1.94384; // best 3-sample average = the squall
  const expected = `N ${sustainedKn.toFixed(1)}k gusts ${Math.round(gustKn)}k`;
  assert.strictEqual(t.segments().wind, expected);
  // reads are non-destructive
  assert.strictEqual(t.segments().wind, expected);
  // a single 1-second spike is NOT a WMO gust: the 3-sample average dilutes it
  const spiky = new Telemetry();
  feedWindContext(spiky);
  const spikySamples = Array(20).fill(5.0);
  spikySamples[10] = 8.0;
  spikySamples.forEach((v, i) => spiky.update('environment.wind.speedApparent', v, now - (20 - i) * 1000));
  assert.ok(!spiky.segments().wind.includes('gusts'), `spike should dilute: ${spiky.segments().wind}`);
  // steady wind → no gust shown
  const steady = new Telemetry();
  feedWindContext(steady);
  [5.29, 5.3, 5.2].forEach((v, i) => steady.update('environment.wind.speedApparent', v, now - (3 - i) * 1000));
  assert.ok(!steady.segments().wind.includes('gusts'));
});

test('wind samples older than 10 minutes fall out of the window', () => {
  const t = new Telemetry();
  feedWindContext(t);
  const now = Date.now();
  // a gale 11 minutes ago must not influence the current reading
  t.update('environment.wind.speedApparent', 25.0, now - 11 * 60000);
  t.update('environment.wind.speedApparent', 5.0, now - 2000);
  t.update('environment.wind.speedApparent', 5.0, now - 1000);
  assert.strictEqual(t.segments().wind, `N ${(5.0 * 1.94384).toFixed(1)}k`);
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
  t.update('environment.wind.angleApparent', 0.506);
  t.update('environment.wind.speedApparent', 5.29);
  t.update('navigation.headingTrue', 0);
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

// --- computed true wind ---
const { trueWind } = Telemetry;

test('trueWind vector math matches hand-calculated cases', () => {
  const near = (a, b) => Math.abs(a - b) < 0.01;
  // head-on apparent, aws 10, boat 4 -> true 6 dead ahead
  let r = trueWind(0, 10, 4);
  assert.ok(near(r.speed, 6) && near(r.angle, 0));
  // beam apparent (90deg), aws 10, boat 4 -> 10.77 @ 111.8deg
  r = trueWind(Math.PI / 2, 10, 4);
  assert.ok(near(r.speed, 10.77) && near(r.angle, (111.8 / 180) * Math.PI));
  // boat stationary -> true == apparent
  r = trueWind(0.5, 7, 0);
  assert.ok(near(r.speed, 7) && near(r.angle, 0.5));
  // missing input -> null
  assert.strictEqual(trueWind(0.5, 7, undefined), null);
});

test('computed mode: under way, vector-subtracts boat motion for true wind', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236); // 30 deg stbd
  t.update('navigation.speedThroughWater', 4); // ~7.8 kn, under way
  t.update('navigation.headingTrue', Math.PI / 2); // due E
  for (let i = 0; i < 5; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (5 - i) * 1000);
  }
  const w = t.segments().wind;
  // renders a true compass point + speed, not a bow-relative angle
  assert.match(w, /^(N|NE|E|SE|S|SW|W|NW) \d/);
  // true wind here is stronger than apparent forward component but the exact
  // magnitude differs from apparent 8 m/s (15.6k) — confirm it changed
  assert.doesNotMatch(w, /15\.6k/);
});

test('computed mode: at rest (<1 kn), apparent IS true — rendered as true', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.speedThroughWater', 0.2); // <1 kn: at rest
  t.update('navigation.headingTrue', Math.PI / 2);
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  // apparent==true at rest: true compass point, speed == apparent (8 m/s=15.6k)
  const w = t.segments().wind;
  assert.match(w, /^(N|NE|E|SE|S|SW|W|NW) 15\.6k/);
});

test('computed mode: absent boat speed treated as at rest (apparent is true)', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.headingTrue', Math.PI / 2);
  // no STW/SOG at all
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  assert.match(t.segments().wind, /^(N|NE|E|SE|S|SW|W|NW) 15\.6k/);
});

test('computed mode: SOG used when STW absent', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.speedOverGround', 4); // only SOG present, under way
  t.update('navigation.headingTrue', Math.PI / 2);
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  const w = t.segments().wind;
  assert.match(w, /^(N|NE|E|SE|S|SW|W|NW) \d/);
  assert.doesNotMatch(w, /15\.6k/); // computed, not passthrough
});

test('computed mode: no heading → wind suppressed and flag set (no erroneous output)', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.speedThroughWater', 4);
  // no headingTrue and no headingMagnetic → can't place a true point
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  const s = t.segments();
  assert.strictEqual(s.wind, undefined, 'no wind segment rendered without heading');
  assert.strictEqual(t.computedWindNoHeading, true, 'no-heading flag raised');
});

test('computed mode: no-heading flag clears once heading returns', () => {
  const now = Date.now();
  const t = new Telemetry({});
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.speedThroughWater', 0.2);
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  t.segments();
  assert.strictEqual(t.computedWindNoHeading, true);
  t.update('navigation.headingMagnetic', Math.PI / 2);
  t.segments();
  assert.strictEqual(t.computedWindNoHeading, false, 'flag clears when heading present');
});

test('computed mode: magnetic heading + variation fallback yields true point', () => {
  const now = Date.now();
  const t = new Telemetry({ variationDegrees: -7 });
  t.update('environment.wind.angleApparent', 0.5236);
  t.update('navigation.speedThroughWater', 0.2); // at rest, simple case
  t.update('navigation.headingMagnetic', Math.PI / 2); // 90 mag, no bus variation
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  // magnetic heading + fallback variation → a valid true compass point
  assert.match(t.segments().wind, /^(N|NE|E|SE|S|SW|W|NW) 15\.6k/);
});

test('computed mode: bus magneticVariation wins over the fallback', () => {
  const now = Date.now();
  const t = new Telemetry({ variationDegrees: -7 });
  t.update('environment.wind.angleApparent', 0);
  t.update('navigation.speedThroughWater', 0.2);
  t.update('navigation.headingMagnetic', 0); // pointing 0 mag
  t.update('navigation.magneticVariation', Math.PI / 2); // bus says +90 → true 90 = E
  for (let i = 0; i < 3; i += 1) {
    t.update('environment.wind.speedApparent', 8, now - (3 - i) * 1000);
  }
  // heading true = 0 + 90 = E, wind dead ahead → E
  assert.match(t.segments().wind, /^E /);
});
