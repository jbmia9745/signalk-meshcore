/* eslint-disable no-console */
// Spike 3: advert exchange. Sends a flood advert from this radio,
// then listens for incoming adverts (PushCodes.Advert = auto-added
// contact) and prints the contact list whenever it changes.
// Run, then tap "Send Advert" on the phone node (SK-DEV2).
//
// Usage: node spike/03-adverts.js <serial device path>

const serialPath = process.argv[2];
if (!serialPath) {
  console.error('Usage: node spike/03-adverts.js <serial device path>');
  process.exit(1);
}

async function main() {
  const { NodeJSSerialConnection, Constants } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  async function listContacts() {
    const contacts = await connection.getContacts();
    console.log(`--- contacts (${contacts.length}) ---`);
    contacts.forEach((c) => {
      const pubKey = Buffer.from(c.publicKey).toString('hex');
      console.log(`${c.advName} type=${c.type} lastAdvert=${c.lastAdvert} pubKey=${pubKey.slice(0, 12)}…`);
    });
  }

  connection.on(Constants.PushCodes.Advert, async (advert) => {
    const pubKey = Buffer.from(advert.publicKey).toString('hex');
    console.log(`>> Advert push received, pubKey=${pubKey.slice(0, 12)}…`);
    await listContacts();
  });

  connection.on(Constants.PushCodes.NewAdvert, (advert) => {
    console.log(`>> NewAdvert push (manual-add mode): ${advert.advName}`);
  });

  connection.on('connected', async () => {
    try {
      console.log('Connected');
      await connection.syncDeviceTime();
      await listContacts();
      await connection.sendFloodAdvert();
      console.log('Flood advert sent. SK-DEV should appear on the phone.');
      console.log('Now tap "Send Advert" on the phone. Listening 120s for adverts…');
      setTimeout(async () => {
        console.log('--- final state ---');
        await listContacts();
        await connection.close();
        process.exit(0);
      }, 120000);
    } catch (e) {
      console.error('Spike failed:', e);
      process.exit(1);
    }
  });

  await connection.connect();
}

main().catch((e) => {
  console.error('Connect failed:', e);
  process.exit(1);
});
