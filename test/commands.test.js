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
  assert.strictEqual(device.sent[0].text, '88.7F');

  await commands.telemetry.handle(verb('batt'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[1].text, '13.3V');

  await commands.telemetry.handle(verb('pos'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[2].text, '38.97000,-76.48000');

  await commands.telemetry.handle(verb('depth'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[3].text, 'No depth data');

  await commands.telemetry.handle(verb('status'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[4].text, 'VESSEL | 88.7F | 13.3V');
});

test('help lists crew-only commands only for crew', async () => {
  const device = mockDevice();
  await commands.help.handle({ from: crewFrom, data: 'help' }, settings, device);
  assert.match(device.sent[0].text, /Turn <switch name> on/);

  await commands.help.handle({ from: strangerFrom, data: 'help' }, settings, device);
  assert.doesNotMatch(device.sent[1].text, /Turn <switch name> on/);
  assert.match(device.sent[1].text, /Ping/);
});

test('short-form aliases resolve to the same commands', async () => {
  const telemetry = new Telemetry();
  telemetry.update('environment.outside.temperature', 304.67);
  telemetry.update('electrical.batteries.house.voltage', 13.29);
  telemetry.update('navigation.position', { latitude: 38.97, longitude: -76.48 });
  const device = mockDevice();
  const verb = (data) => ({ from: crewFrom, data });

  // ping short form
  assert.strictEqual(commands.ping.accept(verb('p')), true);
  await commands.ping.handle(verb('p'), settings, device);
  assert.strictEqual(device.sent[0].text, 'Pong');

  // telemetry short forms match, and produce the same output as long forms
  assert.strictEqual(commands.telemetry.accept(verb('w')), true);
  assert.strictEqual(commands.telemetry.accept(verb('b')), true);
  assert.strictEqual(commands.telemetry.accept(verb('ps')), true);
  assert.strictEqual(commands.telemetry.accept(verb('d')), true);
  assert.strictEqual(commands.telemetry.accept(verb('s')), true);
  assert.strictEqual(commands.telemetry.accept(verb('x')), false);

  await commands.telemetry.handle(verb('w'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[1].text, '88.7F');
  await commands.telemetry.handle(verb('ps'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[2].text, '38.97000,-76.48000');

  // help short form
  assert.strictEqual(commands.help.accept(verb('h')), true);
});

test('batt report appends configured battery temperatures', async () => {
  const telemetry = new Telemetry({
    batteryTemps: [
      { path: 'environment.venus.20.temperature', label: 'Victron' },
      { path: 'environment.venus.26.temperature', label: 'Batt 1' },
    ],
  });
  telemetry.update('electrical.batteries.house.voltage', 13.29);
  telemetry.update('environment.venus.20.temperature', 303.96); // 87.5F
  telemetry.update('environment.venus.26.temperature', 304.14); // 87.8F
  const device = mockDevice();
  await commands.telemetry.handle({ from: crewFrom, data: 'b' }, settings, device, null, telemetry);
  assert.match(device.sent[0].text, /13\.3V/);
  assert.match(device.sent[0].text, /Temps 87\.5\/87\.8F/);
});

test('batt report shows no temps line when no sensors have data', async () => {
  const telemetry = new Telemetry({
    batteryTemps: [{ path: 'environment.venus.20.temperature', label: 'Victron' }],
  });
  telemetry.update('electrical.batteries.house.voltage', 13.29);
  const device = mockDevice();
  await commands.telemetry.handle({ from: crewFrom, data: 'batt' }, settings, device, null, telemetry);
  assert.strictEqual(device.sent[0].text, '13.3V');
});

test('fridge and cabin commands report configured sensor temps', async () => {
  const telemetry = new Telemetry({
    fridgeTempPath: 'environment.inside.refrigerator.temperature',
    cabinTempPath: 'environment.venus.25.temperature',
  });
  telemetry.update('environment.inside.refrigerator.temperature', 273.43); // 32.5F
  telemetry.update('environment.venus.25.temperature', 305.38); // 90.0F
  const device = mockDevice();
  const verb = (data) => ({ from: crewFrom, data });

  assert.strictEqual(commands.sensors.accept(verb('fridge')), true);
  assert.strictEqual(commands.sensors.accept(verb('f')), true);
  assert.strictEqual(commands.sensors.accept(verb('c')), true);
  assert.strictEqual(commands.sensors.accept(verb('cabin')), true);
  assert.strictEqual(commands.sensors.accept(verb('z')), false);

  await commands.sensors.handle(verb('f'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[0].text, 'Fridge 32.5F');
  await commands.sensors.handle(verb('cabin'), settings, device, null, telemetry);
  assert.strictEqual(device.sent[1].text, 'Cabin 90.0F');
});

test('fridge command reports no data when the sensor is absent', async () => {
  const telemetry = new Telemetry();
  const device = mockDevice();
  await commands.sensors.handle({ from: crewFrom, data: 'f' }, settings, device, null, telemetry);
  assert.strictEqual(device.sent[0].text, 'No fridge data');
});
