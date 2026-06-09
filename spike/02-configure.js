/* eslint-disable no-console */
// Spike 2: configure the radio for the US/Canada community preset
// (910.525 MHz, BW 62.5 kHz, SF 7, CR 5) and set the advert name.
// Wire units verified against live selfInfo: freq in kHz, bw in Hz.
//
// Usage: node spike/02-configure.js <serial device path> [advert name]

const serialPath = process.argv[2];
const advertName = process.argv[3] || 'SK-DEV';
if (!serialPath) {
  console.error('Usage: node spike/02-configure.js <serial device path> [advert name]');
  process.exit(1);
}

const US_PRESET = {
  freqKhz: 910525,
  bwHz: 62500,
  sf: 7,
  cr: 5,
};

async function main() {
  const { NodeJSSerialConnection } = await import('@liamcottle/meshcore.js');
  const connection = new NodeJSSerialConnection(serialPath);

  connection.on('connected', async () => {
    try {
      console.log('Connected');

      await connection.syncDeviceTime();
      const p = US_PRESET;
      await connection.setRadioParams(p.freqKhz, p.bwHz, p.sf, p.cr);
      console.log('Radio params set');
      await connection.setAdvertName(advertName);
      console.log(`Advert name set to ${advertName}`);

      const selfInfo = await connection.getSelfInfo();
      console.log('--- selfInfo after config ---');
      console.log(`name=${selfInfo.name}`);
      console.log(`freq=${selfInfo.radioFreq} kHz bw=${selfInfo.radioBw} Hz sf=${selfInfo.radioSf} cr=${selfInfo.radioCr}`);
      console.log(`txPower=${selfInfo.txPower} (max ${selfInfo.maxTxPower})`);

      await connection.close();
      console.log('Done');
      process.exit(0);
    } catch (e) {
      console.error('Configure failed:', e);
      process.exit(1);
    }
  });

  await connection.connect();
}

main().catch((e) => {
  console.error('Connect failed:', e);
  process.exit(1);
});
