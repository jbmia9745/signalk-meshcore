/* eslint-disable no-console */
// Spike 6: channel messaging + position advert.
// 1. Sends a sample telemetry line to channel 0 (Public).
// 2. Sets advert lat/lon and sends a flood advert (check phone for location).
// 3. Listens 180s: post a reply in the Public channel from the phone,
//    and send one DM, to verify live push-while-attached for both kinds.
//
// Usage: node spike/06-channel-position.js <serial device path>

const serialPath = process.argv[2];
if (!serialPath) {
  console.error('Usage: node spike/06-channel-position.js <serial device path>');
  process.exit(1);
}

// Annapolis harbor, as a recognizable test position
const TEST_LAT = 38.97;
const TEST_LON = -76.48;

const SAMPLE_LINE = 'VESSEL T89 H67 P30.10 WdNE Ws10.3 Vb13.3 SoC98 Ib-6.4 D14';

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
        console.log(`>> live DM from ${who}: "${cm.text}"`);
      } else if (m.channelMessage) {
        const ch = m.channelMessage;
        console.log(`>> live channel msg [idx ${ch.channelIdx}]: "${ch.text}" (pathLen=${ch.pathLen})`);
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

      const ch = await connection.findChannelByName('Public');
      if (!ch) {
        console.error('Public channel not found');
        process.exit(1);
      }
      await connection.sendChannelTextMessage(ch.channelIdx, SAMPLE_LINE);
      console.log(`Sent sample telemetry line (${SAMPLE_LINE.length} chars) to channel ${ch.channelIdx} (Public)`);

      // wire format is int32 microdegrees (companion_protocol.md: divided by 1e6)
      await connection.setAdvertLatLong(Math.round(TEST_LAT * 1e6), Math.round(TEST_LON * 1e6));
      await connection.sendFloodAdvert();
      console.log(`Position advert sent (${TEST_LAT}, ${TEST_LON}) — check SK-DEV on the phone map/contact info`);

      const selfInfo = await connection.getSelfInfo();
      console.log(`selfInfo now: advLat=${selfInfo.advLat / 1e6} advLon=${selfInfo.advLon / 1e6}`);

      console.log('Listening 180s — post in Public channel AND send a DM from the phone…');
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
