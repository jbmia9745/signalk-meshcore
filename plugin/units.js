const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

module.exports = {
  kToF: (k) => ((k - 273.15) * 1.8) + 32,
  ratioToPct: (r) => r * 100,
  paToInHg: (pa) => pa / 3386.389,
  paToMb: (pa) => pa / 100,
  msToKn: (ms) => ms * 1.94384,
  mToFt: (m) => m * 3.28084,
  radToDeg: (rad) => ((((rad * 180) / Math.PI) % 360) + 360) % 360,
  radToPoint: (rad) => {
    const deg = ((((rad * 180) / Math.PI) % 360) + 360) % 360;
    return POINTS[Math.round(deg / 45) % 8];
  },
  // Apparent wind angle is bow-relative (-π..π), not a compass bearing.
  // Render as degrees off the bow with P/S side, e.g. "45S" / "120P".
  radToBowAngle: (rad) => {
    const deg = Math.round((Math.abs(rad) * 180) / Math.PI);
    if (deg === 0 || deg === 180) {
      return `${deg}`;
    }
    return `${deg}${rad >= 0 ? 'S' : 'P'}`;
  },
};
