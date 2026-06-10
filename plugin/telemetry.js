const units = require('./units');

function median(arr) {
  if (!arr.length) {
    return undefined;
  }
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] + s[mid]) / 2);
}

// Which Signal K paths feed the wind segment. True wind renders as a
// compass point ("E 8.2K"); apparent is a bow-relative angle ("27S"),
// plus a heading-derived compass point in parens ("27S(E)") when the
// vessel heading is known — exact at rest, an estimate under way.
const WIND_SOURCES = {
  true: {
    directionPath: 'environment.wind.directionTrue',
    speedPath: 'environment.wind.speedOverGround',
    formatDirection: (rad) => units.radToPoint(rad),
  },
  apparent: {
    directionPath: 'environment.wind.angleApparent',
    speedPath: 'environment.wind.speedApparent',
    formatDirection: (rad, heading) => {
      const bow = units.radToBowAngle(rad);
      return Number.isFinite(heading) ? `${bow}(${units.radToPoint(heading + rad)})` : bow;
    },
  },
};

class Telemetry {
  constructor(options = {}) {
    this.data = {};
    this.position = null;
    this.positionAt = null; // ms timestamp of the last accepted position
    this.wind = WIND_SOURCES[options.windSource] || WIND_SOURCES.true;
  }

  update(path, value) {
    if (path === 'navigation.position') {
      if (value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
        // null island: GNSS sources without a fix report ~0,0 — never
        // accept it (observed live: a second N2K source emitting -1e-16)
        && (Math.abs(value.latitude) > 0.01 || Math.abs(value.longitude) > 0.01)) {
        this.position = value;
        this.positionAt = Date.now();
      }
      return;
    }
    if (path === this.wind.speedPath) {
      this.updateWindSpeed(value);
      return;
    }
    this.data[path] = value;
  }

  updateWindSpeed(windSpeed) {
    if (!Number.isFinite(windSpeed)) {
      return;
    }
    if (!this.data[this.wind.speedPath]) {
      this.data[this.wind.speedPath] = [];
    }
    this.data[this.wind.speedPath].push(windSpeed);
  }

  // Best available true heading: headingTrue if present, else
  // headingMagnetic corrected by magneticVariation. Needed to place the
  // apparent wind angle on the compass rose.
  trueHeading() {
    const d = this.data;
    if (Number.isFinite(d['navigation.headingTrue'])) {
      return d['navigation.headingTrue'];
    }
    if (Number.isFinite(d['navigation.headingMagnetic'])) {
      return d['navigation.headingMagnetic'] + (d['navigation.magneticVariation'] || 0);
    }
    return undefined;
  }

  // Human-readable segments, e.g.
  //   { temp: '87.4F', humidity: '65%RH', pressure: '1019mb',
  //     wind: '27S(E) 8.2K G12.6K', depth: 'Depth 12.6FT Dist 98FT',
  //     batt: 'SOC 97% 13.3V +6.2A' }
  // Non-destructive: reading does NOT clear the wind history — the push
  // loop calls clearWindHistory() after a successful send so pull verbs
  // can't blank the buffer.
  segments() {
    const d = this.data;
    const out = {};
    if (Number.isFinite(d['environment.outside.temperature'])) {
      out.temp = `${units.kToF(d['environment.outside.temperature']).toFixed(1)}F`;
    }
    if (Number.isFinite(d['environment.outside.relativeHumidity'])) {
      out.humidity = `${Math.round(units.ratioToPct(d['environment.outside.relativeHumidity']))}%RH`;
    }
    if (Number.isFinite(d['environment.outside.pressure'])) {
      out.pressure = `${Math.round(units.paToMb(d['environment.outside.pressure']))}mb`;
    }
    const dir = Number.isFinite(d[this.wind.directionPath])
      ? this.wind.formatDirection(d[this.wind.directionPath], this.trueHeading())
      : null;
    const ws = d[this.wind.speedPath];
    let speed = null;
    if (Array.isArray(ws) && ws.length) {
      const med = units.msToKn(median(ws));
      const gust = units.msToKn(Math.max(...ws));
      speed = `${med.toFixed(1)}K`;
      // show the gust only when it meaningfully exceeds the median
      if (gust >= med + 2) {
        speed += ` G${gust.toFixed(1)}K`;
      }
    }
    if (dir || speed) {
      out.wind = [dir, speed].filter(Boolean).join(' ');
    }
    if (Number.isFinite(d['environment.depth.belowSurface'])) {
      out.depth = `Depth ${units.mToFt(d['environment.depth.belowSurface']).toFixed(1)}FT`;
      if (Number.isFinite(d['navigation.anchor.distanceFromBow'])) {
        out.depth += ` Dist ${Math.round(units.mToFt(d['navigation.anchor.distanceFromBow']))}FT`;
      }
    } else if (Number.isFinite(d['navigation.anchor.distanceFromBow'])) {
      out.depth = `Dist ${Math.round(units.mToFt(d['navigation.anchor.distanceFromBow']))}FT`;
    }
    const batt = [];
    if (Number.isFinite(d['electrical.batteries.house.capacity.stateOfCharge'])) {
      batt.push(`SOC ${Math.round(units.ratioToPct(d['electrical.batteries.house.capacity.stateOfCharge']))}%`);
    }
    if (Number.isFinite(d['electrical.batteries.house.voltage'])) {
      batt.push(`${d['electrical.batteries.house.voltage'].toFixed(1)}V`);
    }
    if (Number.isFinite(d['electrical.batteries.house.current'])) {
      const amps = d['electrical.batteries.house.current'];
      batt.push(`${amps > 0 ? '+' : ''}${amps.toFixed(1)}A`);
    }
    if (batt.length) {
      out.batt = batt.join(' ');
    }
    return out;
  }

  static joinSegments(s, keys) {
    return keys
      .filter((k) => s[k] !== undefined)
      .map((k) => s[k])
      .join(' | ');
  }

  buildLine(name) {
    const s = this.segments();
    const body = Telemetry.joinSegments(
      s,
      ['temp', 'humidity', 'pressure', 'wind', 'depth', 'batt'],
    );
    if (!body) {
      return null;
    }
    return name ? `${name} | ${body}` : body;
  }

  clearWindHistory() {
    this.data[this.wind.speedPath] = [];
  }
}

module.exports = Telemetry;
