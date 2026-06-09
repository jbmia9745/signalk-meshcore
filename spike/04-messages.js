/* eslint-disable no-console */
// Spike 4: DM exchange + payload-cap test.
// 1. Sends a short DM to the named contact (default SK-DEV2).
// 2. Sends test messages of 130 / 133 / 140 chars (check what the phone shows).
// 3. Listens for MsgWaiting, drains, resolves sender — reply with a DM
//    from the phone during the listen window.
//
// Usage: node spike/04-messages.js <serial device path> [contact name]

const serialPath = process.argv[2];
const contactName = process.argv[3] || 'SK-DEV2';
if (!serialPath) {
  console.error('Usage: node spike/04-messages.js <serial device path> [contact name]');
  process.exit(1);
}

function testString(len) {
  const head = `LEN${len}:`;
  return head + 'abcdefghij'.repeat(14).slice(0, len - head.length);
}

async function main() {
  const { NodeJSSerialConnection, Constants } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  connection.on(Constants.PushCodes.MsgWaiting, async () => {
    try {
      const waiting = await connection.getWaitingMessages();
      for (let i = 0; i < waiting.length; i += 1) {
        const m = waiting[i];
        if (m.contactMessage) {
          const cm = m.contactMessage;
          // eslint-disable-next-line no-await-in-loop
          const contact = await connection.findContactByPublicKeyPrefix(cm.pubKeyPrefix);
          const who = contact ? contact.advName : 'UNKNOWN';
          console.log(`>> DM from ${who}: "${cm.text}" (txtType=${cm.txtType}, pathLen=${cm.pathLen}, senderTimestamp=${cm.senderTimestamp})`);
        } else if (m.channelMessage) {
          console.log(`>> channel msg [idx ${m.channelMessage.channelIdx}]: "${m.channelMessage.text}"`);
        }
      }
    } catch (e) {
      console.error('Drain failed:', e);
    }
  });

  connection.on('connected', async () => {
    try {
      console.log('Connected');
      await connection.syncDeviceTime();

      const contact = await connection.findContactByName(contactName);
      if (!contact) {
        console.error(`Contact ${contactName} not found`);
        process.exit(1);
      }
      const pubKey = contact.publicKey;

      const hello = await connection.sendTextMessage(pubKey, 'Hello from SK-DEV', Constants.TxtTypes.Plain);
      console.log('Sent hello DM:', JSON.stringify(hello));

      const lengths = [130, 133, 140];
      for (let i = 0; i < lengths.length; i += 1) {
        const len = lengths[i];
        const text = testString(len);
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await connection.sendTextMessage(pubKey, text, Constants.TxtTypes.Plain);
          console.log(`Sent ${len}-char message OK:`, JSON.stringify(res));
        } catch (e) {
          console.log(`Send of ${len}-char message FAILED:`, e && e.message ? e.message : e);
        }
      }

      console.log('Listening 120s — reply with a DM from the phone now…');
      setTimeout(async () => {
        await connection.close();
        console.log('Done');
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
