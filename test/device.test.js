const { test } = require('node:test');
const assert = require('node:assert');
const { makeDevice, clamp, MAX_TEXT } = require('../plugin/device');
const CommandQueue = require('../plugin/queue');

const Constants = { TxtTypes: { Plain: 0 } };

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
