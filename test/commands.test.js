const { test } = require('node:test');
const assert = require('node:assert');
const commands = require('../plugin/commands/index');
const Telemetry = require('../plugin/telemetry');

const CREW_KEY = 'd7eb452a2f0c000000000000000000000000000000000000000000000000ffff';
const crewFrom = Uint8Array.from(Buffer.from(CREW_KEY, 'hex'));
const strangerFrom = Uint8Array.from(Buffer.from(CREW_KEY.replace('d7', 'aa'), 'hex'));

const settings = {
  nodes: [{ publicKey: CREW_KEY, role: 'crew' }],
  communications: { digital_switching: true },
  switches: [{ name: 'decklight', path: 'electrical.switches.bank.0.4.state' }],
  telemetry: { vesselName: 'VESSEL' },
};

function mockDevice() {
  const sent = [];
  return {
    sent,
    sendText: (text, to) => {
      sent.push({ text, to });
      return Promise.resolve();
    },
    sendChannelText: (text, channelIdx) => {
      sent.push({ text, channelIdx });
      return Promise.resolve();
    },
  };
}

test('isFromCrew matches crew public key, rejects others', () => {
  assert.strictEqual(commands.isFromCrew({ from: crewFrom }, settings), true);
  assert.strictEqual(commands.isFromCrew({ from: strangerFrom }, settings), false);
  assert.strictEqual(commands.isFromCrew({ from: crewFrom }, { nodes: [] }), false);
});

test('ping replies pong', async () => {
  const device = mockDevice();
  const msg = { from: crewFrom, data: 'Ping' };
  assert.strictEqual(commands.ping.accept(msg), true);
  await commands.ping.handle(msg, settings, device);
  assert.strictEqual(device.sent[0].text, 'Pong');
  assert.strictEqual(device.sent[0].to, crewFrom);
});

test('switching resolves mapped path and falls back to template', async () => {
  const puts = [];
  const app = {
    putSelfPath: (path, value, cb) => {
      puts.push({ path, value });
      cb({ state: 'COMPLETED', statusCode: 200 });
    },
  };
  const device = mockDevice();

  const msg = { from: crewFrom, data: 'turn decklight on' };
  assert.strictEqual(commands.switching.accept(msg, settings), true);
  await commands.switching.handle(msg, settings, device, app);
  assert.deepStrictEqual(puts[0], { path: 'electrical.switches.bank.0.4.state', value: true });
  assert.strictEqual(device.sent[0].text, 'OK, decklight is on');

  const msg2 = { from: crewFrom, data: 'turn anchorlight off' };
  await commands.switching.handle(msg2, settings, device, app);
  assert.deepStrictEqual(puts[1], { path: 'electrical.switches.anchorlight.state', value: false });
});

test('switching is disabled without the settings flag', () => {
  const msg = { from: crewFrom, data: 'turn decklight on' };
  assert.strictEqual(commands.switching.accept(msg, { communications: {} }), false);
});

test('telemetry verbs reply with formatted fields', async () => {
  const telemetry = new Telemetry();
  telemetry.update('environment.outside.temperature', 304.67);
  telemetry.update('electrical.batteries.house.voltage', 13.29);
  telemetry.update('navigation.position', { latitude: 38.97, longitude: -76.48 });
  const device = mockDevice();

  const verb = (data) => ({ from: crewFrom, data });
  assert.strictEqual(commands.telemetry.accept(verb('WX')), true);
  assert.strictEqual(commands.telemetry.accept(verb('nope')), false);

  await commands.telemetry.handle(verb('wx'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[0].text, '89F');

  await commands.telemetry.handle(verb('batt'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[1].text, '13.3v');

  await commands.telemetry.handle(verb('pos'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[2].text, '38.97000,-76.48000');

  await commands.telemetry.handle(verb('depth'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[3].text, 'No depth data');

  await commands.telemetry.handle(verb('status'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[4].text, 'VESSEL | 89F | 13.3v');
});

test('help lists crew-only commands only for crew', async () => {
  const device = mockDevice();
  await commands.help.handle({ from: crewFrom, data: 'help' }, settings, device);
  assert.match(device.sent[0].text, /Turn <switch name> on/);

  await commands.help.handle({ from: strangerFrom, data: 'help' }, settings, device);
  assert.doesNotMatch(device.sent[1].text, /Turn <switch name> on/);
  assert.match(device.sent[1].text, /Ping/);
});
