const { test } = require('node:test');
const assert = require('node:assert');
const { makeDevice, clamp, MAX_TEXT } = require('../plugin/device');
const CommandQueue = require('../plugin/queue');

const Constants = {
  TxtTypes: { Plain: 0 },
  CommandCodes: { SendTelemetryReq: 39 },
  PushCodes: { TelemetryResponse: 0x8b },
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
