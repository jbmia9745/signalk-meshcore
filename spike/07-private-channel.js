/* eslint-disable no-console */
// Spike 7: create a private channel with a random 128-bit secret,
// re-send the corrected position advert (microdegrees), then listen.
// Add the same channel on the phone (name + secret hex), post in it.
//
// Usage: node spike/07-private-channel.js <serial device path> [channel name]

const crypto = require('node:crypto');

const serialPath = process.argv[2];
const channelName = process.argv[3] || 'SK-TEST';
if (!serialPath) {
  console.error('Usage: node spike/07-private-channel.js <serial device path> [channel name]');
  process.exit(1);
}

const TEST_LAT = 38.97;
const TEST_LON = -76.48;

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
      console.log('Connected');
      await connection.syncDeviceTime();
      await drain();

      // reuse the channel if it exists, else create on first empty slot
      let ch = await connection.findChannelByName(channelName);
      if (ch) {
        console.log(`Channel ${channelName} already exists at idx ${ch.channelIdx}`);
        console.log(`SECRET (hex): ${Buffer.from(ch.secret).toString('hex')}`);
      } else {
        const channels = await connection.getChannels();
        const free = channels.find((c) => c.channelIdx !== 0 && !c.name);
        if (!free) {
          console.error('No free channel slot');
          process.exit(1);
        }
        const secret = crypto.randomBytes(16);
        await connection.setChannel(free.channelIdx, channelName, secret);
        ch = await connection.getChannel(free.channelIdx);
        console.log(`Created channel "${ch.name}" at idx ${ch.channelIdx}`);
        console.log(`SECRET (hex): ${Buffer.from(ch.secret).toString('hex')}`);
      }

      await connection.sendChannelTextMessage(ch.channelIdx, 'SK-TEST hello — private channel up');
      console.log('Test message sent to private channel');

      await connection.setAdvertLatLong(Math.round(TEST_LAT * 1e6), Math.round(TEST_LON * 1e6));
      await connection.sendFloodAdvert();
      const selfInfo = await connection.getSelfInfo();
      console.log(`Corrected position advert sent: advLat=${selfInfo.advLat / 1e6} advLon=${selfInfo.advLon / 1e6}`);

      console.log('Listening 240s — add the channel on the phone and post in it…');
      setTimeout(async () => {
        await connection.close();
        console.log('Done');
        process.exit(0);
      }, 240000);
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
