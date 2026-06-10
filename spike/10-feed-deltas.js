/* eslint-disable no-console */
// Phase 4 harness: stream VESSEL-shaped Signal K deltas to the local
// dev server's UDP provider (port 7777) every 5 seconds.
//
// Usage: node spike/10-feed-deltas.js [host] [port]

const dgram = require('node:dgram');

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3], 10) || 7777;
const socket = dgram.createSocket('udp4');

const j = (base, span) => base + ((Math.random() - 0.5) * span);

function delta() {
  return {
    updates: [{
      values: [
        { path: 'environment.outside.temperature', value: j(304.67, 0.6) },
        { path: 'environment.outside.relativeHumidity', value: j(0.6707, 0.01) },
        { path: 'environment.outside.pressure', value: j(101928, 40) },
        { path: 'environment.wind.directionTrue', value: j(0.506, 0.1) },
        {
          path: 'environment.wind.speedOverGround',
          value: Math.random() < 0.25 ? j(9.5, 1) : j(5.29, 1.5),
        },
        { path: 'electrical.batteries.house.voltage', value: j(13.29, 0.05) },
        { path: 'electrical.batteries.house.current', value: j(-6.4, 0.8) },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.985 },
        { path: 'environment.depth.belowSurface', value: j(4.384, 0.3) },
        { path: 'navigation.position', value: { latitude: 38.97, longitude: -76.48 } },
      ],
    }],
  };
}

console.log(`Feeding deltas to ${host}:${port} every 5s — ctrl-c to stop`);
setInterval(() => {
  const msg = Buffer.from(JSON.stringify(delta()));
  socket.send(msg, port, host);
}, 5000);
