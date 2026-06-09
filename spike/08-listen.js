/* eslint-disable no-console */
// Spike 8: listen-only. Connects, drains the device queue, then listens
// for inbound DMs and channel messages until the timeout.
//
// Usage: node spike/08-listen.js <serial device path> [seconds]

const serialPath = process.argv[2];
const seconds = parseInt(process.argv[3], 10) || 600;
if (!serialPath) {
  console.error('Usage: node spike/08-listen.js <serial device path> [seconds]');
  process.exit(1);
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
        console.log(`>> DM from ${contact ? contact.advName : 'UNKNOWN'}: "${cm.text}"`);
      } else if (m.channelMessage) {
        const ch = m.channelMessage;
        console.log(`>> channel msg [idx ${ch.channelIdx}]: "${ch.text}"`);
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
      console.log(`Connected, listening ${seconds}s…`);
      await connection.syncDeviceTime();
      await drain();
      setTimeout(async () => {
        await connection.close();
        console.log('Done');
        process.exit(0);
      }, seconds * 1000);
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
