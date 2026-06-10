const { test } = require('node:test');
const assert = require('node:assert');
const CommandQueue = require('../plugin/queue');

test('commands run strictly one at a time, in order', async () => {
  const queue = new CommandQueue(1000);
  const events = [];
  let inFlight = 0;
  const op = (name, ms) => () => {
    inFlight += 1;
    assert.strictEqual(inFlight, 1, 'two commands in flight');
    events.push(`start:${name}`);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight -= 1;
        events.push(`end:${name}`);
        resolve(name);
      }, ms);
    });
  };
  const results = await Promise.all([
    queue.run(op('a', 30)),
    queue.run(op('b', 5)),
    queue.run(op('c', 1)),
  ]);
  assert.deepStrictEqual(results, ['a', 'b', 'c']);
  assert.deepStrictEqual(events, [
    'start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c',
  ]);
});

test('a timed-out command rejects but the queue keeps going', async () => {
  const queue = new CommandQueue(50);
  const hung = queue.run(() => new Promise(() => {}), 'hung-op');
  await assert.rejects(hung, /timed out: hung-op/);
  const after = await queue.run(() => Promise.resolve('alive'));
  assert.strictEqual(after, 'alive');
});

test('a rejecting command (meshcore.js rejects with undefined) gets an Error', async () => {
  const queue = new CommandQueue(1000);
  await assert.rejects(
    queue.run(() => Promise.reject(), 'sendText'),
    /failed: sendText/,
  );
  assert.strictEqual(await queue.run(() => 'ok'), 'ok');
});

test('onStall fires once after N consecutive timeouts', async () => {
  let stalls = 0;
  const queue = new CommandQueue(20, { stallThreshold: 3, onStall: () => { stalls += 1; } });
  const hang = () => new Promise(() => {});
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(queue.run(hang, `hung-${i}`), /timed out/);
  }
  assert.strictEqual(stalls, 1, 'onStall should fire exactly once at the threshold');
});

test('a settled command resets the stall counter', async () => {
  let stalls = 0;
  const queue = new CommandQueue(20, { stallThreshold: 2, onStall: () => { stalls += 1; } });
  const hang = () => new Promise(() => {});
  await assert.rejects(queue.run(hang), /timed out/);
  // a command that settles (even rejecting) proves the link is alive
  await assert.rejects(queue.run(() => Promise.reject(new Error('nak'))), /nak/);
  await assert.rejects(queue.run(hang), /timed out/);
  assert.strictEqual(stalls, 0, 'counter should reset on any settled command');
  await assert.rejects(queue.run(hang), /timed out/);
  assert.strictEqual(stalls, 1);
});
