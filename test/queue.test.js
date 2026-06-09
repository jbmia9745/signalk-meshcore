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
