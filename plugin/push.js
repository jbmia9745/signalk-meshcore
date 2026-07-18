// Telemetry push loop: one compact line to the configured channel per
// interval. Wind is a rolling WMO 10-minute window (see telemetry.js)
// and is unaffected by sends.
function startTelemetryPush({
  device, telemetry, channelIdx, intervalMs, vesselName, log, afterBuild,
}) {
  const tick = async () => {
    try {
      const line = telemetry.buildLine(vesselName);
      // let the caller react to telemetry state (e.g. warn on no heading in
      // computed wind mode) once per cycle, whether or not a line was sent
      if (afterBuild) {
        afterBuild(telemetry);
      }
      if (line) {
        await device.sendChannelText(line, channelIdx);
        if (log) {
          log(`telemetry push: ${line}`);
        }
      }
    } catch (e) {
      if (log) {
        log(`telemetry push failed: ${e && e.message ? e.message : e}`);
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { startTelemetryPush };
