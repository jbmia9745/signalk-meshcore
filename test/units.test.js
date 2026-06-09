const { test } = require('node:test');
const assert = require('node:assert');
const units = require('../plugin/units');

test('kToF converts VESSEL outside temperature', () => {
  // 304.67 K from the live dump ≈ 88.7 °F
  assert.strictEqual(Math.round(units.kToF(304.67)), 89);
  assert.strictEqual(units.kToF(273.15), 32);
});

test('ratioToPct', () => {
  assert.strictEqual(Math.round(units.ratioToPct(0.6707)), 67);
  assert.strictEqual(Math.round(units.ratioToPct(0.985)), 99);
});

test('paToInHg converts VESSEL pressure', () => {
  // 101928 Pa ≈ 30.10 inHg
  assert.strictEqual(units.paToInHg(101928).toFixed(2), '30.10');
});

test('msToKn', () => {
  assert.strictEqual(units.msToKn(5.29).toFixed(1), '10.3');
});

test('mToFt', () => {
  assert.strictEqual(Math.round(units.mToFt(4.384)), 14);
});

test('radToPoint covers the 8 sectors and wraps', () => {
  const rad = (deg) => (deg * Math.PI) / 180;
  assert.strictEqual(units.radToPoint(rad(0)), 'N');
  assert.strictEqual(units.radToPoint(rad(45)), 'NE');
  assert.strictEqual(units.radToPoint(rad(90)), 'E');
  assert.strictEqual(units.radToPoint(rad(135)), 'SE');
  assert.strictEqual(units.radToPoint(rad(180)), 'S');
  assert.strictEqual(units.radToPoint(rad(225)), 'SW');
  assert.strictEqual(units.radToPoint(rad(270)), 'W');
  assert.strictEqual(units.radToPoint(rad(315)), 'NW');
  // sector edges: each point spans 45° centered on its heading
  assert.strictEqual(units.radToPoint(rad(22.4)), 'N');
  assert.strictEqual(units.radToPoint(rad(22.6)), 'NE');
  assert.strictEqual(units.radToPoint(rad(337.6)), 'N');
  // wraps past 360 and handles negatives
  assert.strictEqual(units.radToPoint(rad(360)), 'N');
  assert.strictEqual(units.radToPoint(rad(-45)), 'NW');
});

test('radToBowAngle renders bow-relative apparent angles', () => {
  const rad = (deg) => (deg * Math.PI) / 180;
  assert.strictEqual(units.radToBowAngle(rad(0)), '0');
  assert.strictEqual(units.radToBowAngle(rad(45)), '45S');
  assert.strictEqual(units.radToBowAngle(rad(-45)), '45P');
  assert.strictEqual(units.radToBowAngle(rad(180)), '180');
  assert.strictEqual(units.radToBowAngle(rad(-120)), '120P');
});
