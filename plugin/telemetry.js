const units = require('./units');

// WMO sustained-wind standard: speed is the mean over a rolling
// 10-minute window; gust is the highest 3-second average within that
// window (at our 1 Hz sampling, a 3-sample moving mean). Independent
// of the push interval by design — an hourly push still reports
// 10-minute wind, not an hour-long smear.
const WIND_WINDOW_MS = 10 * 60000;
const GUST_SAMPLES = 3;
// Below this boat speed the vessel is "at rest" and apparent wind IS true
// wind (anchor/mooring/marina; a boat still swings, so use a threshold not 0).
const AT_REST_MS = 0.514; // 1 knot

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function maxGust(values) {
  if (values.length <= GUST_SAMPLES) {
    return Math.max(...values);
  }
  let best = -Infinity;
  for (let i = 0; i + GUST_SAMPLES <= values.length; i += 1) {
    const g = mean(values.slice(i, i + GUST_SAMPLES));
    if (g > best) {
      best = g;
    }
  }
  return best;
}

// True wind from apparent wind + boat motion (vector subtraction of the
// boat's velocity from the apparent wind vector). Returns { speed, angle }
// where speed is m/s and angle is the true wind angle relative to the bow
// (rad, signed like the apparent angle), or null when inputs are missing.
//
// awa: apparent wind angle rel. bow (rad, +stbd), aws: apparent speed (m/s),
// bs: boat speed (m/s). "true" here is relative to whatever bs represents —
// speed through water (wind over water) or SOG (wind over ground); the
// caller picks the boat-speed source. At bs=0, true == apparent.
function trueWind(awa, aws, bs) {
  if (!Number.isFinite(awa) || !Number.isFinite(aws) || !Number.isFinite(bs)) {
    return null;
  }
  if (bs === 0) {
    return { speed: aws, angle: awa };
  }
  // components: x along the bow-stern axis, y athwartships
  const x = aws * Math.cos(awa) - bs;
  const y = aws * Math.sin(awa);
  const speed = Math.sqrt(x * x + y * y);
  const angle = Math.atan2(y, x);
  return { speed, angle };
}

// The wind segment always reports TRUE wind. There's no true-wind sensor on
// a boat: the masthead reads apparent, so true wind is derived from apparent
// wind + boat motion. Under way (>=1 kn) that's a vector computation; at rest
// (<1 kn) apparent IS true. These are the apparent-wind input paths.
const WIND_ANGLE_PATH = 'environment.wind.angleApparent';
const WIND_SPEED_PATH = 'environment.wind.speedApparent';

class Telemetry {
  constructor(options = {}) {
    this.data = {};
    this.position = null;
    this.positionAt = null; // ms timestamp of the last accepted position
    // Fallback magnetic variation (radians) used to convert magnetic heading
    // to true when the bus does not supply navigation.magneticVariation
    // (e.g. GPS off, so no WMM broadcast). Bus value wins when present.
    // Config is in degrees; default -7 (Miami). East +, West -.
    this.variationFallback = ((options.variationDegrees !== undefined
      ? options.variationDegrees : -7) * Math.PI) / 180;
    // Extra temperature sensors (fridge, cabin, per-battery), path-driven
    // so instance numbers (e.g. environment.venus.25) stay configurable —
    // Ruuvi/Venus instances can renumber. Each battery temp is {path,label}.
    this.fridgeTempPath = options.fridgeTempPath || 'environment.inside.refrigerator.temperature';
    this.cabinTempPath = options.cabinTempPath || 'environment.venus.25.temperature';
    this.batteryTemps = options.batteryTemps || [];
  }

  // °F for a configured temperature path, or null when absent/non-finite.
  tempF(path) {
    const v = this.data[path];
    return Number.isFinite(v) ? units.kToF(v) : null;
  }

  update(path, value, at) {
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
    if (path === WIND_SPEED_PATH) {
      this.updateWindSpeed(value, at);
      return;
    }
    this.data[path] = value;
  }

  updateWindSpeed(windSpeed, at) {
    if (!Number.isFinite(windSpeed)) {
      return;
    }
    if (!this.data[WIND_SPEED_PATH]) {
      this.data[WIND_SPEED_PATH] = [];
    }
    this.data[WIND_SPEED_PATH].push({ t: at || Date.now(), v: windSpeed });
    this.pruneWind(at);
  }

  pruneWind(at) {
    const buf = this.data[WIND_SPEED_PATH];
    if (!Array.isArray(buf)) {
      return;
    }
    const cutoff = (at || Date.now()) - WIND_WINDOW_MS;
    while (buf.length && buf[0].t < cutoff) {
      buf.shift();
    }
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
      // bus variation wins when present; else the configured fallback
      const variation = Number.isFinite(d['navigation.magneticVariation'])
        ? d['navigation.magneticVariation']
        : this.variationFallback;
      return d['navigation.headingMagnetic'] + variation;
    }
    return undefined;
  }

  // Boat speed (m/s): speed through water preferred (wind over water), speed
  // over ground as fallback. Returns a number (may be 0) or null if neither
  // instrument reports.
  boatSpeed() {
    const d = this.data;
    if (Number.isFinite(d['navigation.speedThroughWater'])) {
      return d['navigation.speedThroughWater'];
    }
    if (Number.isFinite(d['navigation.speedOverGround'])) {
      return d['navigation.speedOverGround'];
    }
    return null;
  }

  // Computed-mode true wind → { dir, speed } render strings, or null to let
  // the caller render apparent. Rules:
  //   - boat speed < 1 kn OR absent → apparent IS true; report apparent
  //     magnitude/direction labeled true (a true compass point via heading).
  //   - boat speed ≥ 1 kn → vector-subtract boat motion for genuine true wind.
  //   - no usable heading either way → null (caller shows apparent bow angle;
  //     a true compass point can't be placed without heading).
  // Speed is WMO-smoothed. v1 approximation: at ≥1 kn, true speed is recomputed
  // from buffered apparent samples against the render-time boat speed, not the
  // boat speed at each historical sample (documented limit).
  computeTrueWind() {
    // Reset the no-heading flag each attempt; set only on the heading-missing
    // path below so the plugin can raise/clear a "no heading" warning.
    this.computedWindNoHeading = false;
    const d = this.data;
    const awa = d[WIND_ANGLE_PATH]; // apparent wind angle
    if (!Number.isFinite(awa)) {
      return null;
    }
    this.pruneWind();
    const ws = d[WIND_SPEED_PATH];
    if (!Array.isArray(ws) || !ws.length) {
      return null;
    }
    const heading = this.trueHeading();
    if (!Number.isFinite(heading)) {
      // No heading source at all: a computed true point would be erroneous.
      // Flag it so the plugin warns; return null (no wind segment rendered).
      this.computedWindNoHeading = true;
      return null;
    }
    const bs = this.boatSpeed();
    // At rest (or no speed instrument): apparent IS true. bs=0 makes trueWind
    // a pass-through, so use 0 for both direction and speed smoothing.
    const effectiveBs = (bs === null || bs < AT_REST_MS) ? 0 : bs;
    const twNow = trueWind(awa, ws[ws.length - 1].v, effectiveBs);
    const dir = units.radToPoint(heading + twNow.angle);
    const trueSpeeds = ws
      .map((s) => trueWind(awa, s.v, effectiveBs))
      .filter(Boolean)
      .map((r) => r.speed);
    const sustained = units.msToKn(mean(trueSpeeds));
    const gust = units.msToKn(maxGust(trueSpeeds));
    let speed = `${sustained.toFixed(1)}k`;
    if (gust >= sustained + 2) {
      speed += ` gusts ${Math.round(gust)}k`;
    }
    return { dir, speed };
  }

  // Human-readable segments, e.g.
  //   { temp: '87.4F', humidity: '65%RH', pressure: '1019mb',
  //     wind: '27S(E) 8.2K G12.6K', depth: 'Depth 12.6FT Dist 98FT',
  //     batt: 'SOC 97% 13.3V +6.2A' }
  // Reads are non-destructive; the wind buffer self-prunes by time.
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
    // Wind is always true wind: computeTrueWind derives it (vector math under
    // way, apparent-is-true at rest) and returns { dir, speed }, or null. Null
    // means either no apparent data, or no heading — in the no-heading case it
    // sets computedWindNoHeading and we render nothing (a compass point without
    // heading would be wrong); the plugin raises a warning separately.
    const tw = this.computeTrueWind();
    if (tw) {
      out.wind = [tw.dir, tw.speed].filter(Boolean).join(' ');
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
    // Battery temperatures (Victron + per-cell Ruuvi), appended compactly:
    // "Temps 87.5/87.8/87.9/87.3/87.4F". Only cells with live data show.
    const temps = this.batteryTemps
      .map((b) => this.tempF(b.path))
      .filter((f) => f !== null);
    if (temps.length) {
      batt.push(`Temps ${temps.map((f) => f.toFixed(1)).join('/')}F`);
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
}

module.exports = Telemetry;
module.exports.trueWind = trueWind;
