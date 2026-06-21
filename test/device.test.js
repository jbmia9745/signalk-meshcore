const { test } = require('node:test');
const assert = require('node:assert');
const { makeDevice, clamp, MAX_TEXT } = require('../plugin/device');
const CommandQueue = require('../plugin/queue');

const Constants = {
  TxtTypes: { Plain: 0 },
  CommandCodes: { SendTelemetryReq: 39 },
  PushCodes: { TelemetryResponse: 0x8b, SendConfirmed: 0x82 },
};

test('clamp enforces the 133-char multi-hop-safe cap', () => {
  assert.strictEqual(clamp('x'.repeat(200)).length, MAX_TEXT);
  assert.strictEqual(clamp('short'), 'short');
  assert.strictEqual(MAX_TEXT, 133);
});

test('device adapter routes to meshcore.js calls with clamping', async () => {
  const calls = [];
  const connection = {
    sendTextMessage: (to, text, type) => {
      calls.push({
        kind: 'dm', to, text, type,
      });
      return Promise.resolve({ result: 0 });
    },
    sendChannelTextMessage: (channelIdx, text) => {
      calls.push({ kind: 'channel', channelIdx, text });
      return Promise.resolve();
    },
  };
  const device = makeDevice(connection, Constants, new CommandQueue(1000));
  const key = Uint8Array.from(Buffer.alloc(32, 1));

  await device.sendText('hello', key);
  assert.deepStrictEqual(calls[0], {
    kind: 'dm', to: key, text: 'hello', type: 0,
  });

  await device.sendChannelText('y'.repeat(150), 1);
  assert.strictEqual(calls[1].kind, 'channel');
  assert.strictEqual(calls[1].channelIdx, 1);
  assert.strictEqual(calls[1].text.length, 133);
});

test('every outbound send is logged when a logger is wired', async () => {
  const logged = [];
  const connection = {
    sendTextMessage: () => Promise.resolve(),
    sendChannelTextMessage: () => Promise.resolve(),
  };
  const device = makeDevice(connection, Constants, new CommandQueue(1000), (s) => logged.push(s));
  await device.sendText('hi crew', Uint8Array.from(Buffer.alloc(32, 1)));
  await device.sendChannelText('tick', 1);
  assert.deepStrictEqual(logged, ['OUT dm: hi crew', 'OUT ch1: tick']);
});

test('getSelfTelemetry sends the 4-byte self frame and matches the self prefix', async () => {
  const listeners = {};
  let sentFrame = null;
  const connection = {
    on: (code, fn) => { listeners[code] = fn; },
    off: (code, fn) => { if (listeners[code] === fn) delete listeners[code]; },
    sendToRadioFrame: (frame) => {
      sentFrame = frame;
      // radio answers immediately over serial; an unrelated (crew)
      // response arriving first must be ignored
      listeners[Constants.PushCodes.TelemetryResponse]({
        pubKeyPrefix: Uint8Array.from([9, 9, 9, 9, 9, 9]),
        lppSensorData: Uint8Array.from([1]),
      });
      listeners[Constants.PushCodes.TelemetryResponse]({
        pubKeyPrefix: Uint8Array.from([1, 1, 1, 1, 1, 1]),
        lppSensorData: Uint8Array.from([2]),
      });
      return Promise.resolve();
    },
  };
  const device = makeDevice(connection, Constants, new CommandQueue(1000));
  const self = await device.getSelfTelemetry(Uint8Array.from([1, 1, 1, 1, 1, 1]));
  assert.deepStrictEqual(Array.from(sentFrame), [39, 0, 0, 0]);
  assert.deepStrictEqual(Array.from(self.lppSensorData), [2]);
});

test('delivery confirmation is logged when the matching ack arrives', async () => {
  const logged = [];
  const listeners = {};
  const connection = {
    on: (code, fn) => { listeners[code] = fn; },
    off: (code, fn) => { if (listeners[code] === fn) delete listeners[code]; },
    sendTextMessage: () => Promise.resolve({ result: 0, expectedAckCrc: 1234, estTimeout: 5000 }),
  };
  const device = makeDevice(connection, Constants, new CommandQueue(1000), (s) => logged.push(s));
  await device.sendText('hi', Uint8Array.from(Buffer.alloc(32, 1)));
  // unrelated ack must be ignored, matching ack logs delivery
  listeners[Constants.PushCodes.SendConfirmed]({ ackCode: 9999, roundTrip: 1 });
  listeners[Constants.PushCodes.SendConfirmed]({ ackCode: 1234, roundTrip: 777 });
  assert.deepStrictEqual(logged, ['OUT dm: hi', 'DELIVERED dm (round trip 777ms)']);
  assert.strictEqual(listeners[Constants.PushCodes.SendConfirmed], undefined);
});

test('a missed delivery confirmation triggers exactly one retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logged = [];
  const listeners = {};
  let sends = 0;
  const connection = {
    on: (code, fn) => { listeners[code] = fn; },
    off: (code, fn) => { if (listeners[code] === fn) delete listeners[code]; },
    sendTextMessage: () => {
      sends += 1;
      return Promise.resolve({ result: 0, expectedAckCrc: 100 + sends, estTimeout: 1000 });
    },
  };
  const device = makeDevice(connection, Constants, new CommandQueue(60000), (s) => logged.push(s), {
    dmRetries: 1, retryGapSeconds: 2,
  });
  device.sendText('hello there', Uint8Array.from(Buffer.alloc(32, 1)));
  await new Promise((r) => { setImmediate(r); }); await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(sends, 1);
  // first attempt's ack never arrives -> timeout fires -> retry scheduled
  t.mock.timers.tick(7000);
  await new Promise((r) => { setImmediate(r); });
  t.mock.timers.tick(2500);
  await new Promise((r) => { setImmediate(r); }); await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(sends, 2, 'one retry transmitted');
  // retry delivers
  listeners[Constants.PushCodes.SendConfirmed]({ ackCode: 102, roundTrip: 1500 });
  assert.ok(logged.some((l) => l.includes('DELIVERED dm retry 1')));
  // retry of the retry must NOT happen even if its window had lapsed
  t.mock.timers.tick(20000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(sends, 2);
});

// --- Auto reset-path on terminal DM delivery failure (design v2.3) ---

// Build a connection that never delivers (no SendConfirmed for the DM), so
// every directed send reaches terminal miss. resetPath records its calls and
// resolves/rejects per opts. Recovery sends are tracked separately.
function makeResetHarness(opts = {}) {
  const events = [];
  const listeners = {};
  const resets = [];
  let sends = 0;
  const connection = {
    on: (code, fn) => { listeners[code] = fn; },
    off: (code, fn) => { if (listeners[code] === fn) delete listeners[code]; },
    sendTextMessage: () => {
      sends += 1;
      return Promise.resolve({ result: 0, expectedAckCrc: 1000 + sends, estTimeout: 1000 });
    },
    sendChannelTextMessage: () => Promise.resolve(),
    resetPath: (to) => {
      resets.push(Buffer.from(to).toString('hex'));
      return opts.resetRejects
        ? Promise.reject(new Error('reset Err 3'))
        : Promise.resolve();
    },
  };
  return {
    connection, events, listeners, resets, sendCount: () => sends,
  };
}

// Drive a DM to terminal miss: tick past the ack window (estTimeout 1000 +
// 5000 + margin). dmRetries defaults to 0 here so the first miss is terminal.
async function driveToTerminalMiss(t, device, key) {
  device.sendText('hello there', key);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  t.mock.timers.tick(7000);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
}

test('reset once on terminal miss; one recovery send after the gap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const logged = [];
  const push = (s) => logged.push(s);
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), push, {
    dmRetries: 0, resetRecoveryGapSeconds: 3, resetPathCooldownMinutes: 10,
  });
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  await driveToTerminalMiss(t, device, key);
  // reset fired exactly once, keyed by full pubkey hex
  assert.deepStrictEqual(h.resets, [Buffer.from(key).toString('hex')]);
  assert.ok(logged.some((l) => l.startsWith('PATH RESET ')), 'PATH RESET logged');
  // first DM only so far; recovery waits for the gap
  assert.strictEqual(h.sendCount(), 1);
  t.mock.timers.tick(3500);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.sendCount(), 2, 'one recovery send after the gap');
  assert.ok(logged.some((l) => l.startsWith('DM RECOVERY RESEND ')), 'recovery logged');
});

test('recovery does not recurse (no second reset, no third send)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0, resetRecoveryGapSeconds: 3, resetPathCooldownMinutes: 10,
  });
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  await driveToTerminalMiss(t, device, key);
  t.mock.timers.tick(3500);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  // recovery itself misses its ack — must NOT trigger another reset/resend
  t.mock.timers.tick(20000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.resets.length, 1, 'no second reset from recovery');
  assert.strictEqual(h.sendCount(), 2, 'no third send from recovery');
});

test('no reset while retries remain; successful retry cancels reset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 1, retryGapSeconds: 2, resetPathCooldownMinutes: 10,
  });
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  device.sendText('hello there', key);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  t.mock.timers.tick(7000); // first miss -> retry scheduled, NOT reset
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.resets.length, 0, 'no reset with a retry remaining');
  t.mock.timers.tick(2500); // retry sends
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.sendCount(), 2);
  // retry delivers -> no terminal miss -> no reset
  h.listeners[Constants.PushCodes.SendConfirmed]({ ackCode: 1002, roundTrip: 50 });
  t.mock.timers.tick(20000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.resets.length, 0, 'delivered retry cancels reset');
});

test('reset_path_on_failure=false = legacy stop-after-retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0, resetPathOnFailure: false,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  assert.strictEqual(h.resets.length, 0, 'disabled = no reset');
  assert.strictEqual(h.sendCount(), 1, 'no recovery send');
});

test('resend_after_path_reset=false = reset only, no recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0, resendAfterPathReset: false, resetRecoveryGapSeconds: 3,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  assert.strictEqual(h.resets.length, 1, 'reset fired');
  t.mock.timers.tick(5000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.sendCount(), 1, 'no recovery send when resend off');
});

test('reset failure is logged + swallowed; no recovery resend', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness({ resetRejects: true });
  const logged = [];
  const push = (s) => logged.push(s);
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), push, {
    dmRetries: 0, resetRecoveryGapSeconds: 3,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  assert.ok(logged.some((l) => l.startsWith('PATH RESET FAILED ')), 'failure logged');
  t.mock.timers.tick(5000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.sendCount(), 1, 'failed reset -> no recovery resend');
});

test('cooldown suppresses a repeat reset for the same contact', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  let clock = 0;
  const logged = [];
  const push = (s) => logged.push(s);
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), push, {
    dmRetries: 0, resendAfterPathReset: false, resetPathCooldownMinutes: 10, nowMs: () => clock,
  });
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  await driveToTerminalMiss(t, device, key);
  assert.strictEqual(h.resets.length, 1);
  clock += 5 * 60000; // 5 min later, still inside the 10-min cooldown
  await driveToTerminalMiss(t, device, key);
  assert.strictEqual(h.resets.length, 1, 'second reset suppressed');
  assert.ok(logged.some((l) => l.startsWith('PATH RESET SUPPRESSED ')), 'suppression logged');
  clock += 6 * 60000; // now past the cooldown
  await driveToTerminalMiss(t, device, key);
  assert.strictEqual(h.resets.length, 2, 'reset allowed after cooldown lapses');
});

test('cooldown keys by FULL pubkey: a shared 6-byte prefix does not collide', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0, resendAfterPathReset: false, resetPathCooldownMinutes: 10,
  });
  // same first 6 bytes, differ at byte 7 -> distinct contacts
  const a = Buffer.alloc(32, 5); const b = Buffer.alloc(32, 5); b[6] = 9;
  await driveToTerminalMiss(t, device, Uint8Array.from(a));
  await driveToTerminalMiss(t, device, Uint8Array.from(b));
  assert.strictEqual(h.resets.length, 2, 'both reset — full-key keying, no prefix collision');
});

test('reset_path_cooldown_minutes=0 disables suppression', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0, resendAfterPathReset: false, resetPathCooldownMinutes: 0,
  });
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  await driveToTerminalMiss(t, device, key);
  await driveToTerminalMiss(t, device, key);
  assert.strictEqual(h.resets.length, 2, 'cooldown 0 -> every terminal miss resets');
});

test('channel send never resets or tracks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0,
  });
  await device.sendChannelText('tick', 1);
  t.mock.timers.tick(20000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.resets.length, 0, 'channel send never resets');
});

test('missing expectedAckCrc never resets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  // override sendTextMessage to omit expectedAckCrc
  h.connection.sendTextMessage = () => Promise.resolve({ result: 0 });
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), null, {
    dmRetries: 0,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  t.mock.timers.tick(20000);
  await new Promise((r) => { setImmediate(r); });
  assert.strictEqual(h.resets.length, 0, 'no ack tracking -> no reset');
});

test('reset and recovery go through queue.run with distinct labels', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const labels = [];
  const h = makeResetHarness();
  // wrap a real queue to capture labels
  const realQueue = new CommandQueue(60000);
  const queue = { run: (fn, label) => { labels.push(label); return realQueue.run(fn, label); } };
  const device = makeDevice(h.connection, Constants, queue, null, {
    dmRetries: 0, resetRecoveryGapSeconds: 3,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  t.mock.timers.tick(3500);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  assert.ok(labels.includes('sendText'), 'initial send labeled sendText');
  assert.ok(labels.includes('resetPath'), 'reset labeled resetPath');
  assert.ok(labels.includes('sendTextRecovery'), 'recovery labeled sendTextRecovery');
});

test('recovery resend send failure is caught + logged; no unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeResetHarness();
  const logged = [];
  // first send succeeds (to reach terminal miss), recovery send throws
  let n = 0;
  h.connection.sendTextMessage = () => {
    n += 1;
    if (n === 1) return Promise.resolve({ result: 0, expectedAckCrc: 1, estTimeout: 1000 });
    return Promise.reject(new Error('queue/send blew up'));
  };
  const push = (s) => logged.push(s);
  const device = makeDevice(h.connection, Constants, new CommandQueue(60000), push, {
    dmRetries: 0, resetRecoveryGapSeconds: 3,
  });
  await driveToTerminalMiss(t, device, Uint8Array.from(Buffer.alloc(32, 7)));
  t.mock.timers.tick(3500);
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  assert.ok(logged.some((l) => l.startsWith('DM RECOVERY RESEND FAILED ')), 'failure caught + logged');
});
