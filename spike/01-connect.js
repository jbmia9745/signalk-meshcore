/* eslint-disable no-console */
// Spike 1: connect to a MeshCore Companion radio over USB serial,
// query identity, battery, time, contacts, and channels, then disconnect.
//
// Usage: node spike/01-connect.js /dev/cu.usbmodemXXXX

const serialPath = process.argv[2];
if (!serialPath) {
  console.error('Usage: node spike/01-connect.js <serial device path>');
  process.exit(1);
}

async function main() {
  const { NodeJSSerialConnection } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  connection.on('connected', async () => {
    try {
      console.log('Connected');

      const selfInfo = await connection.getSelfInfo();
      console.log('--- selfInfo ---');
      console.log(JSON.stringify(selfInfo, (k, v) => (
        v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v
      ), 2));

      const battery = await connection.getBatteryVoltage();
      console.log('--- battery ---');
      console.log(JSON.stringify(battery));

      const time = await connection.getDeviceTime();
      console.log('--- device time ---');
      console.log(JSON.stringify(time), '(host time:', Math.floor(Date.now() / 1000), ')');
      if (Math.abs(time.epochSecs - Date.now() / 1000) > 60) {
        await connection.syncDeviceTime();
        const synced = await connection.getDeviceTime();
        console.log('clock was off, synced to:', JSON.stringify(synced));
      }

      const contacts = await connection.getContacts();
      console.log(`--- contacts (${contacts.length}) ---`);
      contacts.forEach((c) => {
        const pubKey = Buffer.from(c.publicKey).toString('hex');
        console.log(`${c.advName} type=${c.type} pubKey=${pubKey.slice(0, 12)}…`);
      });

      const channels = await connection.getChannels();
      console.log(`--- channels (${channels.length}) ---`);
      channels.filter((ch) => ch.name).forEach((ch) => {
        console.log(`idx=${ch.channelIdx} name=${JSON.stringify(ch.name)} secret=${Buffer.from(ch.secret).toString('hex').slice(0, 8)}…`);
      });

      await connection.close();
      console.log('Done');
      process.exit(0);
    } catch (e) {
      console.error('Query failed:', e);
      process.exit(1);
    }
  });

  await connection.connect();
}

main().catch((e) => {
  console.error('Connect failed:', e);
  process.exit(1);
});
