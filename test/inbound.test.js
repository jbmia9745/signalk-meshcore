const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { attachInbound, parseChannelText } = require('../plugin/inbound');
const Telemetry = require('../plugin/telemetry');
const CommandQueue = require('../plugin/queue');

const Constants = { PushCodes: { MsgWaiting: 0x83 } };
const CONTACT = {
  publicKey: Uint8Array.from(Buffer.alloc(32, 0xd7)),
  advName: 'SK-DEV2',
};

function mockConnection(queue) {
  const conn = new EventEmitter();
  conn.getWaitingMessages = async () => queue.splice(0);
  conn.findContactByPublicKeyPrefix = async (prefix) => {
    const hex = Buffer.from(prefix).toString('hex');
    return hex === 'd7d7d7d7d7d7' ? CONTACT : undefined;
  };
  return conn;
}

function mockApp() {
  return { debug: () => {}, error: () => {} };
}

function deps(extra = {}) {
  const sent = [];
  return {
    sent,
    settings: { nodes: [] },
    device: {
      sendText: (text, to) => {
        sent.push({ text, to });
        return Promise.resolve();
      },
    },
    app: mockApp(),
    telemetry: new Telemetry(),
    queue: new CommandQueue(1000),
    ...extra,
  };
}

test('parseChannelText splits sender prefix, tolerates none', () => {
  assert.deepStrictEqual(
    parseChannelText('SK-DEV2: Test'),
    { sender: 'SK-DEV2', text: 'Test' },
  );
  assert.deepStrictEqual(
    parseChannelText('no prefix here'),
    { sender: null, text: 'no prefix here' },
  );
});

test('initial drain dispatches queued DM to a command', async () => {
  const queue = [{
    contactMessage: {
      pubKeyPrefix: Uint8Array.from(Buffer.alloc(6, 0xd7)),
      text: 'ping',
      senderTimestamp: 1781000000,
    },
  }];
  const d = deps();
  await attachInbound(mockConnection(queue), Constants, d);
  // dispatch resolves handler promises asynchronously
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(d.sent[0].text, 'Pong');
  assert.strictEqual(d.sent[0].to, CONTACT.publicKey);
});

test('MsgWaiting push triggers a drain', async () => {
  const queue = [];
  const conn = mockConnection(queue);
  const d = deps();
  await attachInbound(conn, Constants, d);

  queue.push({
    contactMessage: {
      pubKeyPrefix: Uint8Array.from(Buffer.alloc(6, 0xd7)),
      text: 'PING',
      senderTimestamp: 1781000001,
    },
  });
  conn.emit(Constants.PushCodes.MsgWaiting);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(d.sent[0].text, 'Pong');
});

test('unknown contact is ignored, channel messages are forwarded not dispatched', async () => {
  const channelMsgs = [];
  const queue = [
    {
      contactMessage: {
        pubKeyPrefix: Uint8Array.from(Buffer.alloc(6, 0xaa)),
        text: 'ping',
        senderTimestamp: 1,
      },
    },
    {
      channelMessage: { channelIdx: 1, text: 'SK-DEV2: ping', senderTimestamp: 2 },
    },
  ];
  const d = deps({ onChannelMessage: (m) => channelMsgs.push(m) });
  await attachInbound(mockConnection(queue), Constants, d);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(d.sent.length, 0);
  assert.deepStrictEqual(channelMsgs, [{
    channelIdx: 1, sender: 'SK-DEV2', text: 'ping', senderTimestamp: 2,
  }]);
});
