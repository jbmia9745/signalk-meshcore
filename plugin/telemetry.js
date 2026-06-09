const units = require('./units');

function median(arr) {
  if (!arr.length) {
    return undefined;
  }
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] + s[mid]) / 2);
}

// Which Signal K paths feed the wind fields, and how they are labeled
// in the output line. 'true' wind is a compass bearing; 'apparent' is
// a bow-relative angle and is labeled/rendered differently to stay honest.
const WIND_SOURCES = {
  true: {
    directionPath: 'environment.wind.directionTrue',
    speedPath: 'environment.wind.speedOverGround',
    directionLabel: 'Wd',
    speedLabel: 'Ws',
    formatDirection: (rad) => units.radToPoint(rad),
  },
  apparent: {
    directionPath: 'environment.wind.angleApparent',
    speedPath: 'environment.wind.speedApparent',
    directionLabel: 'Wa',
    speedLabel: 'Wsa',
    formatDirection: (rad) => units.radToBowAngle(rad),
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

  // Imperial/SAE field set. Non-destructive: reading does NOT clear the
  // wind history — the push loop calls clearWindHistory() after a
  // successful send so pull verbs can't blank the buffer.
  toImperial() {
    const d = this.data;
    const out = {};
    if (Number.isFinite(d['environment.outside.temperature'])) {
      out.T = Math.round(units.kToF(d['environment.outside.temperature']));
    }
    if (Number.isFinite(d['environment.outside.relativeHumidity'])) {
      out.H = Math.round(units.ratioToPct(d['environment.outside.relativeHumidity']));
    }
    if (Number.isFinite(d['environment.outside.pressure'])) {
      out.P = units.paToInHg(d['environment.outside.pressure']).toFixed(2);
    }
    if (Number.isFinite(d[this.wind.directionPath])) {
      out[this.wind.directionLabel] = this.wind.formatDirection(d[this.wind.directionPath]);
    }
    const ws = d[this.wind.speedPath];
    if (Array.isArray(ws) && ws.length) {
      out[this.wind.speedLabel] = units.msToKn(median(ws)).toFixed(1);
    }
    if (Number.isFinite(d['electrical.batteries.house.voltage'])) {
      out.Vb = d['electrical.batteries.house.voltage'].toFixed(1);
    }
    if (Number.isFinite(d['electrical.batteries.house.current'])) {
      out.Ib = d['electrical.batteries.house.current'].toFixed(1);
    }
    if (Number.isFinite(d['electrical.batteries.house.capacity.stateOfCharge'])) {
      out.SoC = Math.round(units.ratioToPct(d['electrical.batteries.house.capacity.stateOfCharge']));
    }
    if (Number.isFinite(d['navigation.anchor.distanceFromBow'])) {
      out.Anc = Math.round(units.mToFt(d['navigation.anchor.distanceFromBow']));
    } else if (Number.isFinite(d['environment.depth.belowSurface'])) {
      out.D = Math.round(units.mToFt(d['environment.depth.belowSurface']));
    }
    return out;
  }

  buildLine(name) {
    const f = this.toImperial();
    const order = [
      'T', 'H', 'P',
      this.wind.directionLabel, this.wind.speedLabel,
      'Vb', 'SoC', 'Ib', 'D', 'Anc',
    ];
    const parts = order
      .filter((k) => f[k] !== undefined)
      .map((k) => `${k}${f[k]}`);
    if (!parts.length) {
      return null;
    }
    return name ? `${name} ${parts.join(' ')}` : parts.join(' ');
  }

  clearWindHistory() {
    this.data[this.wind.speedPath] = [];
  }
}

module.exports = Telemetry;
