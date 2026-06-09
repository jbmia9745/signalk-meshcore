# Project Plan — Port `signalk-meshtastic` to MeshCore

**Audience:** implementing engineer. **Status legend:** `[VERIFIED]` confirmed by inspecting source of both repos or official docs; `[PROPOSED]` design choice, not a spec; `[ESTIMATE]` not measured; `[OPEN]` must be resolved before committing.

---

## 1. Summary / key finding

This is a re-platform, not a transport swap. Meshtastic floods messages and broadcasts typed packets; MeshCore uses contact-based, path-learning routing where Companion client nodes do not repeat packets `[VERIFIED]`. The plugin's packet-subscription ingest layer must be rewritten.

Native Meshtastic-style structured telemetry is **dropped**. Telemetry is delivered as **bot-style text messages** (scheduled push + on-demand pull) using only fully-supported MeshCore messaging primitives, in **Imperial / SAE units**. This removes all firmware-side dependency.

---

## 2. Verified basis

### Source app (`signalk-meshtastic` v1.2.4, ~1,360 LOC JS, GPLv3) `[VERIFIED]`
- Depends on `@meshtastic/core` + HTTP/TCP/serial transports + `@bufbuild/protobuf`.
- Ingests via event subscriptions: `onNodeInfoPacket`, `onMeshPacket`, `onMessagePacket`, `onTelemetryPacket`, `onPositionPacket`, `onMyNodeInfo`, `onDeviceStatus`.
- Sends via `device.sendText(text, to, wantAck, wantResponse)`, `device.sendWaypoint(...)`, and constructed telemetry protobufs.
- Identity keyed on Meshtastic node number (`num`) + short/long name.
- Command framework: each module in `plugin/commands/` exports `{ crewOnly, example, accept(msg), handle(msg, settings, device, app) }`. `accept(msg)` branches on `msg.data` (text); `handle` replies via `device.sendText(..., msg.from, ...)`. `commands/index.js` aggregates handlers + `help` + `isFromCrew(msg, settings)`.
- `Telemetry` class (`plugin/telemetry.js`) accumulates raw SI values keyed by Signal K path via `update(path, value)` / `updateWindSpeed(v)` (rolling array for median/gust/lull), and converts in `toMeshtastic()`. **This method is what we replace.**

### Target (MeshCore) `[VERIFIED]`
- Official Node client: `meshcore.js` (npm `@liamcottle/meshcore.js`). NodeJS connects over TCP/WiFi (`TCPConnection(host, port)`) or USB Serial (`NodeJSSerialConnection(path)`). No HTTP transport.
- Companion radio is the server; binary frame protocol over BLE / USB / WiFi-TCP.
- Ingest model: push code `MsgWaiting (0x83)` → drain via `getWaitingMessages()` → array of `{ contactMessage }` / `{ channelMessage }` / `{ channelData }`.
  - `contactMessage = { pubKeyPrefix(6 bytes), pathLen, txtType, senderTimestamp, text }`
  - `channelMessage = { channelIdx, pathLen, txtType, senderTimestamp, text }`
- Resolve sender: `findContactByPublicKeyPrefix(pubKeyPrefix)` → `contact.publicKey`.
- Send: `sendTextMessage(contactPublicKey, text, Constants.TxtTypes.Plain)`, `sendChannelTextMessage(channelIdx, text)`.
- Channels: `getChannels()`, `findChannelByName(name)` → `channel.channelIdx`.
- Identity is public-key / contact based. Position-out via `setAdvertLatLong(lat, lon)`; adverts carry optional lat/lon.
- Bot command pattern demonstrated in `examples/command_bot.js`.

### Signal K units `[VERIFIED]`
Signal K values are always SI for a given key (e.g. `speedOverGround` is always m/s). Temperature = Kelvin, pressure = Pascal, angles = radians, depth/distance = meters, voltage = volts, current = amps.

---

## 3. Scope

**In scope**
- TCP and Serial transports (HTTP dropped).
- Node/contact discovery via adverts; persistent DB re-keyed on public key.
- Text alerts out; text command framework (digital switching, ping, telemetry query verbs).
- Boat position out via advert lat/lon.
- Position-sharing MeshCore nodes shown as vessels in Signal K.
- `DE <callsign>` node↔vessel association (re-keyed to pubkey).
- Telemetry out via bot messages, Imperial units (Section 5).

**Out of scope (v1)**
- Native Meshtastic-style structured telemetry — dropped.
- Waypoints (no MeshCore equivalent; verified absent): breaks AIS-waypoint share and MOB-waypoint. MOB degrades to a text alert with lat/lon.
- Meshtastic-specific roles (`ROUTER_LATE`, `CLIENT_BASE`).

---

## 4. Technical considerations

1. Rewrite the ingest layer: `MsgWaiting` → drain loop + advert handling, replacing packet subscriptions.
2. Identity remap (node num → public key) touches DB schema, Signal K context/MMSI association, and `DE` matching.
3. HTTP transport removed — migration note for existing users (Companion WiFi = TCP).
4. Verify Companion link exclusivity vs concurrent phone/web clients.
5. License: GPLv3 source + MIT client are compatible for a GPLv3 derivative.
6. Verify `meshcore.js` Node `engines` against Venus OS Large's bundled Node (source app intentionally supports Node <22).

---

## 5. Telemetry approach — bot messaging (Imperial / SAE)

The plugin reads Signal K paths (already normalized from the N2K bus), converts to Imperial, and sends as text. Two patterns:

- **Push (routine):** one compact line to a dedicated telemetry channel on an interval, via `sendChannelTextMessage`. One message per cycle to conserve airtime.
- **Pull (on-demand):** crew texts a verb; plugin replies via `sendTextMessage`. Reuses the existing command framework.

### Path → field mapping (paths + units `[VERIFIED]`; field codes + formats `[PROPOSED]`)

Live source column validated against a real data dump from vessel **VESSEL** (sailing vessel, `design.aisShipType` = Sailing/36). ✓ = confirmed present; ⚠ = present but with a data-quality caveat (see 5.4).

| Field | Signal K path | SI in | Output | Formula | Live source (VESSEL) |
|---|---|---|---|---|---|
| `T` | `environment.outside.temperature` | K | °F | `(K − 273.15) × 1.8 + 32` | ✓ signalk-path-mapper (304.67 K) |
| `H` | `environment.outside.relativeHumidity` | ratio 0–1 | % | `× 100` | ✓ signalk-path-mapper (0.6707) |
| `P` | `environment.outside.pressure` | Pa | inHg | `÷ 3386.389` | ✓ signalk-path-mapper (101928 Pa) |
| `Wd` | `environment.wind.directionTrue` | rad | 8-point compass | see below | ⚠ present, but fed from `angleApparent` |
| `Ws` | `environment.wind.speedOverGround` (median, 10 min) | m/s | kn | `× 1.94384` | ⚠ present, but fed from `speedApparent` |
| `Vb` | `electrical.batteries.house.voltage` | V | V | — | ✓ signalk-path-mapper (13.29 V) |
| `Ib` | `electrical.batteries.house.current` | A | A (signed) | — | ✓ signalk-path-mapper (−6.4 A) |
| `SoC` | `electrical.batteries.house.capacity.stateOfCharge` | ratio 0–1 | % | `× 100` | ✓ signalk-path-mapper (0.985) |
| `Anc` | `navigation.anchor.distanceFromBow` | m | ft | `× 3.28084` (when anchored) | — not anchored in snapshot |
| `D` | `environment.depth.belowSurface` | m | ft | `× 3.28084` (when not anchored) | ✓ n2k 128267 (4.384 m) |
| `pos` | `navigation.position` | lat/lon | decimal° | — | ⚠ only (−1e‑7, −1e‑7) from MT node; no real GNSS |

Wind direction → 8-point compass:
```
deg   = ((rad × 180/π) mod 360 + 360) mod 360
idx   = round(deg / 45) mod 8
point = ["N","NE","E","SE","S","SW","W","NW"][idx]
```
Each point spans 45° centered on its heading (N = 337.5°–22.5°, NE = 22.5°–67.5°, …).

### Push-line format `[PROPOSED]`
One line, space-delimited. The leading tag is the vessel `name` (e.g. `VESSEL`) — both a source identifier and a way for receivers/parsers to distinguish telemetry from chat. (The earlier `MV` tag was wrong: VESSEL is a sailing vessel; use the actual `name` path, configurable.) Fields with no current value are omitted. The anchored→`Anc` / not-anchored→`D` switch mirrors existing plugin logic.
```
VESSEL T89 H67 P30.10 WdNE Ws10.3 Vb13.3 SoC98 Ib-6.4 D14
```
Values above are the actual VESSEL snapshot run through the conversions. At anchor the tail is `Anc<ft>` instead of `D14`. ~55–65 chars with the name tag + SoC; keep an eye on the payload cap (Open #1).

### Pull command verbs `[PROPOSED]`
`wx` (T H P Wd Ws) · `batt` (Vb Ib SoC) · `pos` (lat/lon) · `depth` (D or Anc) · `status` (full line) · `help` (verb list). Existing `turn <switch> on|off` and `ping` coexist unchanged.

### 5.4 Live data validation — vessel VESSEL `[VERIFIED from data dump]`

A real Signal K dump confirmed the assumed canonical paths exist on this boat, and surfaced issues that must be handled in implementation.

**Canonical paths depend on `signalk-path-mapper`.** On VESSEL, every field the plugin reads (`electrical.batteries.house.*`, `environment.outside.*`, `environment.wind.directionTrue`, `environment.wind.speedOverGround`) is produced by the `signalk-path-mapper` plugin, which aliases raw device-instance paths into the canonical names. Raw sources live under instance paths — e.g. the house bank is physically `electrical.batteries.278.*` (Victron SmartShunt via `venus.com.victronenergy.battery.ttyS6`). **Implication:** the telemetry module must read the canonical `.house` / `.outside` paths and must NOT assume they exist without path-mapper configured. Document path-mapper (or equivalent) as a prerequisite.

**Battery-instance hygiene — critical.** The dump contains many battery instances: `0`, `1`, `239`, `278` (SmartShunt), `house` (alias of 278), and `1236626816`. The last one is the **Meshtastic node's own battery** (`electrical.batteries.1236626816.voltage` = 4.33 V, SoC 101%, source `signalk-meshtastic`). The telemetry module must read only `electrical.batteries.house.*` and never a bare numeric instance, or it will report the LoRa device's cell as the boat's house bank.

**`Wd`/`Ws` are apparent, not true `[OPEN]`.** On this boat `environment.wind.directionTrue` (0.506 rad) equals `environment.wind.angleApparent` (0.506 rad), and `environment.wind.speedOverGround` (5.29 m/s) equals `environment.wind.speedApparent` (5.29 m/s). The path-mapper is feeding apparent values into the "true"/SOG paths. As-is, telemetry would broadcast apparent wind labeled as true. Either fix the mapping upstream, or relabel the fields as apparent (`Wa`/`Wsa`). Decide before release.

**No real position fix `[OPEN]`.** The only `navigation.position` in the dump is (−1e‑7, −1e‑7) sourced from the Meshtastic plugin's own node — i.e. null-island placeholder, not a GNSS fix. The `pos` verb and any position-out advert need a genuine GNSS source on the bus; verify one is present before relying on `pos`.

**Humidity / SoC are ratios.** Both render as percentages in the Signal K UI but are stored as ratios (0.6707, 0.985); `× 100` is correct, consistent with the existing `toMeshtastic()` handling of `relativeHumidity`.

**Digital-switching path structure `[OPEN]`.** The existing switching command targets `electrical.switches.${name}.state`, but VESSEL's actual switches are `electrical.switches.bank.0.<N>.state` (N2K switch bank, PGN 127501) plus `electrical.switches.venus-*` and `electrical.switches.gx.*`. The command's path template must be made configurable or matched to the `bank.0.<N>` structure, or switching will target non-existent paths.

**Optional expanded field catalog** (real paths present on VESSEL; keep out of the default push line for airtime, expose as pull verbs or opt-in):

| Suggested field | Signal K path | SI in | Output |
|---|---|---|---|
| `TR` (time remaining) | `electrical.batteries.house.capacity.timeRemaining` | s | hours (`÷ 3600`) |
| `Pw` (house power) | `electrical.batteries.house.power` | W | W |
| `Wtr` (water temp) | `environment.water.temperature` | K | °F |
| `Frg` (fridge temp) | `environment.inside.refrigerator.temperature` | K | °F |
| `Sol` (solar power) | `electrical.solar.279.panelPower` | W | W |
| `Hdg` (heading mag) | `navigation.headingMagnetic` | rad | ° (or compass) |
| `AP` (autopilot) | `steering.autopilot.state` | string | passthrough |

---

## 6. Proposed module designs

> All code below is `[PROPOSED]` / illustrative, matching the existing CommonJS style. API calls and object shapes are grounded in verified `meshcore.js` source, but the code is **not yet tested against hardware**. Treat as a starting scaffold, not a finished implementation.

### 6.1 New: `plugin/units.js` (conversion helpers)

```js
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

module.exports = {
  kToF: (k) => (k - 273.15) * 1.8 + 32,
  ratioToPct: (r) => r * 100,
  paToInHg: (pa) => pa / 3386.389,
  msToKn: (ms) => ms * 1.94384,
  mToFt: (m) => m * 3.28084,
  radToPoint: (rad) => {
    const deg = (((rad * (180 / Math.PI)) % 360) + 360) % 360;
    return POINTS[Math.round(deg / 45) % 8];
  },
};
```

### 6.2 Extend `plugin/telemetry.js`

Add an Imperial formatter and a non-destructive design. **Behavior note:** the existing `toMeshtastic()` clears wind history on read. With both a push loop and pull verbs reading the same instance, the read must NOT clear — the push loop clears explicitly after a successful send (so pull verbs don't blank the wind buffer). `median()` already exists in this file.

```js
const units = require('./units');

// inside class Telemetry:

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
  if (Number.isFinite(d['environment.wind.directionTrue'])) {
    out.Wd = units.radToPoint(d['environment.wind.directionTrue']);
  }
  const ws = d['environment.wind.speedOverGround'];
  if (Array.isArray(ws) && ws.length) {
    out.Ws = units.msToKn(median(ws)).toFixed(1);
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

buildLine() {
  const f = this.toImperial();
  const order = ['T', 'H', 'P', 'Wd', 'Ws', 'Vb', 'SoC', 'Ib', 'D', 'Anc'];
  const parts = order
    .filter((k) => f[k] !== undefined)
    .map((k) => `${k}${f[k]}`);
  return parts.length ? `MV ${parts.join(' ')}` : null;
}

clearWindHistory() {
  this.data['environment.wind.speedOverGround'] = [];
}
```

`navigation.position` must be fed into the `Telemetry` instance (or read at handle time). To stay consistent with the existing subscription-based design, add `navigation.position` to the subscription list in `index.js` and store `{ latitude, longitude }`; the `pos` verb then reads it from the instance. (Avoids depending on an unverified `getSelfPath` call.)

### 6.3 New: `plugin/commands/telemetry.js` (pull handler)

Slots into the existing framework. **Wiring change required:** the dispatcher must pass the `Telemetry` instance to `handle`. Extend the call to `handle(msg, settings, device, app, telemetry)`; existing handlers that ignore the 5th arg are unaffected.

```js
function fmt(fields, keys) {
  const parts = keys.filter((k) => fields[k] !== undefined).map((k) => `${k}${fields[k]}`);
  return parts.join(' ');
}

module.exports = {
  crewOnly: false,
  example: 'WX | Batt | Pos | Depth | Status',
  accept: (msg) => ['wx', 'batt', 'pos', 'depth', 'status']
    .includes(msg.data.trim().toLowerCase()),
  handle: (msg, settings, device, app, telemetry) => {
    const verb = msg.data.trim().toLowerCase();
    const f = telemetry.toImperial();
    let reply;
    switch (verb) {
      case 'wx':
        reply = fmt(f, ['T', 'H', 'P', 'Wd', 'Ws']) || 'No wx data';
        break;
      case 'batt':
        reply = fmt(f, ['Vb', 'Ib', 'SoC']) || 'No batt data';
        break;
      case 'depth':
        if (f.Anc !== undefined) reply = `Anc${f.Anc}`;
        else if (f.D !== undefined) reply = `D${f.D}`;
        else reply = 'No depth data';
        break;
      case 'pos': {
        const p = telemetry.position; // { latitude, longitude } stored from subscription
        reply = (p && Number.isFinite(p.latitude))
          ? `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`
          : 'No position';
        break;
      }
      case 'status':
      default:
        reply = telemetry.buildLine() || 'No telemetry';
    }
    return device.sendText(reply, msg.from, true, false);
  },
};
```
Register in `commands/index.js`: `exports.telemetry = require('./telemetry');`

### 6.4 Backend adapter (keeps command handlers backend-agnostic)

Command handlers call `device.sendText(text, to, wantAck, wantResponse)`. Provide a thin adapter over the `meshcore.js` connection so handlers don't change. `to` is the contact public key.

```js
const { Constants } = require('@liamcottle/meshcore.js');

function makeDevice(connection) {
  return {
    sendText: (text, to /* publicKey */, _wantAck, _wantResponse) =>
      connection.sendTextMessage(to, text, Constants.TxtTypes.Plain),
    sendChannelText: (text, channelIdx) =>
      connection.sendChannelTextMessage(channelIdx, text),
  };
}

module.exports = { makeDevice };
```

### 6.5 Inbound dispatch (ingest rewrite, replaces packet subscriptions)

Normalizes a MeshCore contact message into the `{ from, data }` shape the existing command dispatch expects (`from` = contact public key, `data` = text).

```js
const { Constants } = require('@liamcottle/meshcore.js');

function attachInbound(connection, { dispatch, settings, device, app, telemetry, log }) {
  connection.on(Constants.PushCodes.MsgWaiting, async () => {
    try {
      const waiting = await connection.getWaitingMessages();
      for (const m of waiting) {
        if (!m || !m.contactMessage) continue; // channel msgs handled separately if needed
        const contact = await connection
          .findContactByPublicKeyPrefix(m.contactMessage.pubKeyPrefix);
        if (!contact) continue;
        const msg = { from: contact.publicKey, data: m.contactMessage.text };
        dispatch(msg, settings, device, app, telemetry);
      }
    } catch (e) {
      if (log) log(`inbound drain failed: ${e.message}`);
    }
  });
}

module.exports = { attachInbound };
```
`dispatch` reuses the existing logic from `index.js` (iterate command modules, first whose `accept(msg)` is true, run `handle` after the `crewOnly` / `isFromCrew` check). Only the source of `msg` changes.

### 6.6 New: `plugin/meshcore-telemetry-push.js` (push-loop)

```js
function startTelemetryPush({
  connection, telemetry, channelIdx, intervalMs, log,
}) {
  let timer = null;

  const tick = async () => {
    try {
      const line = telemetry.buildLine();
      if (line) {
        await connection.sendChannelTextMessage(channelIdx, line);
      }
      telemetry.clearWindHistory(); // clear after send, not on read
    } catch (e) {
      if (log) log(`telemetry push failed: ${e.message}`);
    }
  };

  timer = setInterval(tick, intervalMs);
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}

module.exports = { startTelemetryPush };
```

Startup wiring in `index.js` (channel resolution `[VERIFIED]` API):
```js
const ch = await connection.findChannelByName(settings.telemetry.channelName || 'Public');
if (!ch) { app.error('Telemetry channel not found'); }
const stop = startTelemetryPush({
  connection,
  telemetry,
  channelIdx: ch.channelIdx,
  intervalMs: (settings.telemetry.intervalMinutes || 10) * 60 * 1000,
  log: (s) => app.debug(s),
});
// call stop() in plugin.stop()
```

### 6.7 Config schema additions `[PROPOSED]`
- `telemetry.enabled` (bool)
- `telemetry.channelName` (string, default `Public`)
- `telemetry.intervalMinutes` (number, default 10)
- `telemetry.pullVerbsEnabled` (bool)
- `telemetry.includeStateOfCharge` (bool; optional path, see Open #2)

Units are fixed to Imperial per requirement; a `units` toggle could be added later if SI/metric output is ever needed.

---

## 7. Effort — `[ESTIMATE]` only

One experienced engineer:
- Transport + connection lifecycle: ~2–3 days
- Ingest rewrite (queue + adverts) + DB/identity remap: ~5–8 days
- Outbound messaging + command rewiring + adapter: ~2–3 days
- Telemetry bot (units + formatter + push loop + verbs): ~2–4 days
- Hardware soak test, docs, release: ~3–5 days

**Total: ~2.5–4 weeks**, no firmware dependency.

---

## 8. Execution (phased, gated)

- **Phase 0 — Spike (2–3 days):** `meshcore.js` against a Companion device; confirm Open Items.
- **Phase 1 — Connectivity:** transport, connect/reconnect, device query, time sync.
- **Phase 2 — Read path:** adverts → node DB → Signal K contexts; message-queue drain; position-sharing nodes as vessels.
- **Phase 3 — Write path:** alerts as text, command handlers + adapter, position-out via advert.
- **Phase 4 — Telemetry bot:** `units.js`, `Telemetry` formatter, push loop, query verbs.
- **Phase 5 — Harden:** soak test, migration docs (HTTP→TCP), release as a new package (`signalk-meshcore`) rather than a breaking change.

---

## 9. Open items `[OPEN]`

1. **MeshCore max text payload size** — unverified. Sets the hard cap on the push line; if tight, split or drop low-priority fields. Verify in Phase 0.
2. **True vs apparent wind** — on VESSEL, `directionTrue`/`speedOverGround` are fed from apparent values by path-mapper. Fix the mapping upstream or relabel the telemetry fields as apparent. Decide before release. (See 5.4.)
3. **No real GNSS fix** — the only `navigation.position` observed was null-island from the Meshtastic node. Confirm a genuine GNSS source on the bus before relying on `pos` or position-out advert. (See 5.4.)
4. **Digital-switching path structure** — actual switches are `electrical.switches.bank.0.<N>.state`, not the command's `electrical.switches.<name>.state` template. Make configurable. (See 5.4.)
5. **Path-mapper prerequisite** — canonical `.house`/`.outside` paths exist only because `signalk-path-mapper` is configured. Document as a dependency; do not assume on other vessels.
6. **Stale-data policy** — max age before a field is omitted vs sent stale.
7. **Regional LoRa duty-cycle / airtime limits** — confirm push interval stays within local regulations.
8. **`meshcore.js` Node `engines`** — runs on Venus OS Large's bundled Node?
9. **Companion link exclusivity** with concurrent phone/web clients.
10. **Channel setup/secret handling** for the telemetry channel (creation, sharing with crew).
11. **Upstream author intent** (`meri-imperiumi`) — raise an issue before forking.

**Closed:** State of charge — confirmed present as `electrical.batteries.house.capacity.stateOfCharge` (ratio); now a first-class `SoC` field.

---

## Appendix A — Publishing to the Signal K AppStore `[VERIFIED]`

There is no registration portal or approval step. The Signal K AppStore is an index built from npm: published plugins become available in all existing Signal K server installations, with each server fetching the listing live (requires internet). Publishing the package to npm with the correct metadata is the entire process.

**Process**

1. **Keywords in `package.json` (this is what makes it appear).** Include `signalk-node-server-plugin` for a server plugin, and/or `signalk-webapp` for a webapp UI. Add `signalk-category-*` keyword(s) to file it under AppStore categories.
2. **Optional display/behavior keys.** A `signalk` object sets `appIcon` and `displayName`; `signalk-plugin-enabled-by-default` controls whether it auto-enables after install.
3. **Publish to npm** — `npm publish` from the folder containing `package.json`. It then surfaces in every server's AppStore search. (No other gatekeeping.)

**Design constraint:** the AppStore installs packages with `npm install --ignore-scripts` for security, so `preinstall`/`install`/`postinstall` scripts will NOT run. Do not rely on install hooks (e.g. native builds) — ship pure JS or bundle prebuilt artifacts.

**Applicability to this port:** the existing `signalk-meshtastic` already carries `signalk-node-server-plugin`, `signalk-category-ais`, `signalk-category-hardware`. The new `signalk-meshcore` package reuses the same keyword scheme; no additional steps. Keep `license` GPLv3 (matching the source) and confirm the `engines` Node range (Open #8) before publishing.

**Authoritative reference (verify current keyword/category list + release tooling before publishing):** Signal K "Publishing to the AppStore" docs — https://demo.signalk.org/documentation/develop/plugins/publishing.html
