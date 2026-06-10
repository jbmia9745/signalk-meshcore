const { test } = require('node:test');
const assert = require('node:assert');
const { startTelemetryPush } = require('../plugin/push');
const Telemetry = require('../plugin/telemetry');

function mockDevice(failures = 0) {
  let remainingFailures = failures;
  const sent = [];
  return {
    sent,
    sendChannelText: (text, channelIdx) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(new Error('radio busy'));
      }
      sent.push({ text, channelIdx });
      return Promise.resolve();
    },
  };
}

test('push sends a line per tick and clears wind history after send', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const telemetry = new Telemetry();
  telemetry.update('environment.wind.speedOverGround', 5.29);
  const device = mockDevice();

  const stop = startTelemetryPush({
    device, telemetry, channelIdx: 1, intervalMs: 1000, vesselName: 'VESSEL',
  });

  t.mock.timers.tick(1000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(device.sent.length, 1);
  assert.strictEqual(device.sent[0].text, 'VESSEL | 10.3k');
  assert.strictEqual(device.sent[0].channelIdx, 1);
  // wind history cleared after the successful send
  assert.strictEqual(telemetry.segments().wind, undefined);

  // nothing left to send → no message next tick
  t.mock.timers.tick(1000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(device.sent.length, 1);

  stop();
  t.mock.timers.tick(5000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(device.sent.length, 1);
});

test('failed send keeps wind history and logs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const telemetry = new Telemetry();
  telemetry.update('environment.wind.speedOverGround', 5.29);
  const device = mockDevice(1);
  const logs = [];

  const stop = startTelemetryPush({
    device, telemetry, channelIdx: 1, intervalMs: 1000, log: (s) => logs.push(s),
  });

  t.mock.timers.tick(1000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(device.sent.length, 0);
  assert.match(logs[0], /radio busy/);
  // history retained → retried next tick
  t.mock.timers.tick(1000);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(device.sent.length, 1);
  assert.strictEqual(device.sent[0].text, '10.3k');
  stop();
});
