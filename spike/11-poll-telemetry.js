/* eslint-disable no-console */
// Spike 11: poll a contact's telemetry (pull model) and dump the parsed
// CayenneLPP items. Tests private, contact-to-contact position polling.
//
// Usage: node spike/11-poll-telemetry.js <serial device path> [contact name]

const serialPath = process.argv[2];
const contactName = process.argv[3] || 'SK-DEV2';
if (!serialPath) {
  console.error('Usage: node spike/11-poll-telemetry.js <serial device path> [contact name]');
  process.exit(1);
}

async function main() {
  const { NodeJSSerialConnection, CayenneLpp } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  connection.on('connected', async () => {
    try {
      console.log('Connected');
      await connection.syncDeviceTime();
      const contact = await connection.findContactByName(contactName);
      if (!contact) {
        console.error(`Contact ${contactName} not found`);
        process.exit(1);
      }
      console.log(`Polling telemetry from ${contactName}…`);
      const telemetry = await connection.getTelemetry(contact.publicKey);
      const parsed = CayenneLpp.parse(telemetry.lppSensorData);
      console.log(JSON.stringify(parsed, null, 2));
      const gps = parsed.find((item) => item.type === CayenneLpp.LPP_GPS);
      if (gps) {
        console.log(`GPS: ${JSON.stringify(gps.value)}`);
      } else {
        console.log('No GPS item in telemetry response');
      }
      await connection.close();
      process.exit(0);
    } catch (e) {
      console.error('Telemetry poll failed:', e && e.message ? e.message : e);
      process.exit(1);
    }
  });

  await connection.connect();
}

main().catch((e) => {
  console.error('Connect failed:', e);
  process.exit(1);
});
