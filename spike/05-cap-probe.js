/* eslint-disable no-console */
// Spike 5: precise payload-cap probe + inbound listen.
// Sends messages of exact lengths whose LAST characters are an END marker:
// if a message is truncated in transit, the marker visibly disappears.
//   probe(133) ends with "<END133"
//   probe(140) ends with "<END140"
//   probe(150) ends with "<END150"
// Then listens 180s for inbound DMs (reply from the phone).
//
// Usage: node spike/05-cap-probe.js <serial device path> [contact name]

const serialPath = process.argv[2];
const contactName = process.argv[3] || 'SK-DEV2';
if (!serialPath) {
  console.error('Usage: node spike/05-cap-probe.js <serial device path> [contact name]');
  process.exit(1);
}

function probe(len) {
  const marker = `<END${len}`;
  const filler = '0123456789'.repeat(20).slice(0, len - marker.length);
  return filler + marker;
}

async function main() {
  const { NodeJSSerialConnection, Constants } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  async function drain() {
    const waiting = await connection.getWaitingMessages();
    for (let i = 0; i < waiting.length; i += 1) {
      const m = waiting[i];
      if (m.contactMessage) {
        const cm = m.contactMessage;
        // eslint-disable-next-line no-await-in-loop
        const contact = await connection.findContactByPublicKeyPrefix(cm.pubKeyPrefix);
        const who = contact ? contact.advName : 'UNKNOWN';
        console.log(`>> DM from ${who} (${cm.text.length} chars): "${cm.text}"`);
      }
    }
  }

  connection.on(Constants.PushCodes.MsgWaiting, async () => {
    try {
      await drain();
    } catch (e) {
      console.error('Drain failed:', e);
    }
  });

  connection.on('connected', async () => {
    try {
      console.log('Connected');
      await connection.syncDeviceTime();
      console.log('--- initial drain (messages queued on device while no client attached) ---');
      await drain();
      console.log('--- initial drain done ---');
      const contact = await connection.findContactByName(contactName);
      if (!contact) {
        console.error(`Contact ${contactName} not found`);
        process.exit(1);
      }

      const lengths = [133, 140, 150];
      for (let i = 0; i < lengths.length; i += 1) {
        const text = probe(lengths[i]);
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await connection.sendTextMessage(
            contact.publicKey,
            text,
            Constants.TxtTypes.Plain,
          );
          console.log(`probe(${lengths[i]}) accepted by radio:`, JSON.stringify(res));
        } catch (e) {
          console.log(`probe(${lengths[i]}) REJECTED:`, e && e.message ? e.message : e);
        }
        // space sends out to avoid airtime collisions
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 4000); });
      }

      console.log('Probes sent. Listening 180s — reply with a DM from the phone now…');
      setTimeout(async () => {
        await connection.close();
        console.log('Done');
        process.exit(0);
      }, 180000);
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
