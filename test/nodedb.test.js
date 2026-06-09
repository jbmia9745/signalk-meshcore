const { test } = require('node:test');
const assert = require('node:assert');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { mkdtemp } = require('node:fs/promises');
const NodeDb = require('../plugin/nodedb');

function contact(overrides = {}) {
  return {
    publicKey: Uint8Array.from(Buffer.alloc(32, 0xd7)),
    advName: 'SK-DEV2',
    type: 1,
    lastAdvert: 1781044255,
    advLat: 38970000,
    advLon: -76480000,
    ...overrides,
  };
}

test('updateFromContact keys on pubkey hex and scales microdegrees', async () => {
  const db = new NodeDb('/nonexistent/node-db.json');
  const { key, node } = db.updateFromContact(contact());
  assert.strictEqual(key, 'd7'.repeat(32));
  assert.strictEqual(node.name, 'SK-DEV2');
  assert.strictEqual(node.advLat, 38.97);
  assert.strictEqual(node.advLon, -76.48);
  assert.strictEqual(node.seen.getTime(), 1781044255000);
});

test('zero lat/lon advert means no position', () => {
  const db = new NodeDb('/nonexistent/node-db.json');
  const { node } = db.updateFromContact(contact({ advLat: 0, advLon: 0 }));
  assert.strictEqual(node.advLat, undefined);
});

test('save/load round-trips with Date revival', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nodedb-'));
  const file = join(dir, 'node-db.json');
  const db = new NodeDb(file);
  db.updateFromContact(contact());
  await db.save();

  const db2 = new NodeDb(file);
  await db2.load();
  const node = db2.get('d7'.repeat(32));
  assert.strictEqual(node.name, 'SK-DEV2');
  assert.ok(node.seen instanceof Date);
});

test('load survives a missing or corrupt file', async () => {
  const db = new NodeDb('/nonexistent/node-db.json');
  await db.load();
  assert.deepStrictEqual(db.nodes, {});
});

test('callsignOf matches the DE pattern', () => {
  assert.strictEqual(NodeDb.callsignOf({ name: 'Dinghy DE WDL1234' }), 'WDL1234');
  assert.strictEqual(NodeDb.callsignOf({ name: 'SK-DEV2' }), null);
  assert.strictEqual(NodeDb.callsignOf(undefined), null);
});

test('onlineCount respects the threshold', () => {
  const db = new NodeDb('/nonexistent/node-db.json');
  const now = new Date('2026-06-09T20:00:00Z');
  db.nodes.fresh = { seen: new Date('2026-06-09T19:30:00Z') };
  db.nodes.stale = { seen: new Date('2026-06-09T10:00:00Z') };
  db.nodes.never = {};
  assert.strictEqual(db.onlineCount(7200, now), 1);
});
