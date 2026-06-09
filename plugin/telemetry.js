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
// compass bearing ("NE@9.6k"); apparent is a bow-relative angle and is
// marked as such ("45S@9.6k(A)") to stay honest.
const WIND_SOURCES = {
  true: {
    directionPath: 'environment.wind.directionTrue',
    speedPath: 'environment.wind.speedOverGround',
    formatDirection: (rad) => units.radToPoint(rad),
    suffix: '',
  },
  apparent: {
    directionPath: 'environment.wind.angleApparent',
    speedPath: 'environment.wind.speedApparent',
    formatDirection: (rad) => units.radToBowAngle(rad),
    suffix: '(A)',
  },
};

class Telemetry {
  constructor(options = {}) {
    this.data = {};
    this.position = null;
    this.wind = WIND_SOURCES[options.windSource] || WIND_SOURCES.true;
  }

  update(path, value) {
    if (path === 'navigation.position') {
      if (value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
        this.position = value;
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

  // Human-readable segments, e.g.
  //   { temp: '89F', humidity: '67%', pressure: '1019mb', wind: 'NE@10.3k',
  //     depth: '14ft', soc: '99%soc', voltage: '13.3v', current: '-6.4a' }
  // Non-destructive: reading does NOT clear the wind history — the push
  // loop calls clearWindHistory() after a successful send so pull verbs
  // can't blank the buffer.
  segments() {
    const d = this.data;
    const out = {};
    if (Number.isFinite(d['environment.outside.temperature'])) {
      out.temp = `${Math.round(units.kToF(d['environment.outside.temperature']))}F`;
    }
    if (Number.isFinite(d['environment.outside.relativeHumidity'])) {
      out.humidity = `${Math.round(units.ratioToPct(d['environment.outside.relativeHumidity']))}%`;
    }
    if (Number.isFinite(d['environment.outside.pressure'])) {
      out.pressure = `${Math.round(units.paToMb(d['environment.outside.pressure']))}mb`;
    }
    const dir = Number.isFinite(d[this.wind.directionPath])
      ? this.wind.formatDirection(d[this.wind.directionPath])
      : null;
    const ws = d[this.wind.speedPath];
    const speed = (Array.isArray(ws) && ws.length)
      ? `${units.msToKn(median(ws)).toFixed(1)}k`
      : null;
    if (dir && speed) {
      out.wind = `${dir}@${speed}${this.wind.suffix}`;
    } else if (speed) {
      out.wind = `${speed} wind${this.wind.suffix}`;
    } else if (dir) {
      out.wind = `${dir} wind${this.wind.suffix}`;
    }
    if (Number.isFinite(d['environment.depth.belowSurface'])) {
      out.depth = `${Math.round(units.mToFt(d['environment.depth.belowSurface']))}ft`;
    }
    if (Number.isFinite(d['navigation.anchor.distanceFromBow'])) {
      out.anchor = `anc ${Math.round(units.mToFt(d['navigation.anchor.distanceFromBow']))}ft`;
    }
    if (Number.isFinite(d['electrical.batteries.house.capacity.stateOfCharge'])) {
      out.soc = `${Math.round(units.ratioToPct(d['electrical.batteries.house.capacity.stateOfCharge']))}%soc`;
    }
    if (Number.isFinite(d['electrical.batteries.house.voltage'])) {
      out.voltage = `${d['electrical.batteries.house.voltage'].toFixed(1)}v`;
    }
    if (Number.isFinite(d['electrical.batteries.house.current'])) {
      const amps = d['electrical.batteries.house.current'];
      out.current = `${amps > 0 ? '+' : ''}${amps.toFixed(1)}a`;
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
      ['temp', 'humidity', 'pressure', 'wind', 'depth', 'anchor', 'soc', 'voltage', 'current'],
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
