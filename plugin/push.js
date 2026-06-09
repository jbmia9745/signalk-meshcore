// Telemetry push loop: one compact line to the configured channel per
// interval. Wind history is cleared only after a successful send so the
// pull verbs never see a blanked buffer (spec §6.2 behavior note).
function startTelemetryPush({
  device, telemetry, channelIdx, intervalMs, vesselName, log,
}) {
  const tick = async () => {
    try {
      const line = telemetry.buildLine(vesselName);
      if (line) {
        await device.sendChannelText(line, channelIdx);
        telemetry.clearWindHistory();
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
