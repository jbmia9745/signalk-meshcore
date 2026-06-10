# signalk-meshcore

Signal K plugin for interfacing with the [MeshCore](https://meshcore.io/) LoRa mesh network.

**Status: feature-complete in desk testing; on-boat validation pending before first npm release.**

Connects a Signal K server to a MeshCore Companion radio over USB serial or TCP/WiFi, providing:

- **Telemetry bot** — a compact, human-readable boat-status line pushed to a private MeshCore channel on an interval:
  `VESSEL | 87.4F | 65%RH | 1019mb | 42S(E) 7.5k gusts 11k | Depth 12.6FT Dist 98FT | SOC 97% 13.3V +6.2A`
- **Pull verbs** — DM the boat `wx`, `batt`, `pos`, `depth`, `status`, `help`, or `ping` and get an answer.
- **Digital switching** — crew DM `turn <switch> on|off`, with switch names mapped to real Signal K paths (N2K bank paths supported).
- **Alerts** — Signal K `alarm`/`emergency` notifications go to crew as DMs and optionally to a channel. MOB notifications degrade to a text alert with lat/lon (MeshCore has no waypoints).
- **Crew positions, privately** — the plugin polls crew nodes' telemetry (encrypted, contact-to-contact) and plots them as vessels in Signal K/Freeboard. No broadcast of crew location required.
- **Boat position out** — vessel GNSS position published via MeshCore adverts so crew find the boat on the MeshCore app map.

This is a port of [signalk-meshtastic](https://github.com/meri-imperiumi/signalk-meshtastic) by Henri Bergius (GPLv3) to the MeshCore platform, using [meshcore.js](https://github.com/meshcore-dev/meshcore.js) (MIT). It is a re-platform, not a transport swap: MeshCore's contact-based routing replaces packet subscriptions, identity is keyed on public keys, and native structured telemetry is replaced by bot-style text (the MeshCore companion protocol has no host-injected telemetry — verified against firmware v1.16 source).

## Requirements

- **Radio**: a MeshCore-supported LoRa board (developed and tested on Heltec WiFi LoRa 32 V4) flashed with **canonical MeshCore Companion firmware ≥ 1.15** from [flasher.meshcore.io](https://flasher.meshcore.io):
  - `companion_radio_usb` for USB serial (recommended; data + power over one cable), or
  - `companion_radio_wifi` for TCP — note this variant is a source build with WiFi credentials as compile-time flags; it is not in the release flasher.
  - The MeshOS fork's unified firmware is untested and unsupported.
- **Node.js ≥ 22** (matches upstream signalk-meshtastic).
- **Signal K paths**: telemetry reads the canonical paths `electrical.batteries.house.*`, `environment.outside.*`, `environment.wind.*`, `environment.depth.belowSurface`, `navigation.anchor.distanceFromBow`. On Venus OS and similar, these may only exist if [signalk-path-mapper](https://www.npmjs.com/package/signalk-path-mapper) (or equivalent) aliases the raw device-instance paths. The plugin never reads numeric battery instances — only `house`.

## Setup walkthrough

1. **Flash the radio** (Chrome/Edge, [flasher.meshcore.io](https://flasher.meshcore.io)): Companion USB, ≥1.15. Set the regional frequency preset to match your local mesh (e.g. USA/Canada 910.525 MHz / 62.5 kHz / SF7 / CR5).
2. **Install the plugin** from the Signal K AppStore (or `npm install signalk-meshcore` in your server's config dir).
3. **Configure the connection**: transport `serial` + the device path (e.g. `/dev/ttyACM0` — the radio is native USB CDC), or `tcp` + host (port 5000).
4. **Create a private telemetry channel**: never push telemetry to Public — it is a live regional channel. Create a named channel with a random 128-bit secret on the radio (the MeshCore web client over USB can do this, as can a short script; an in-plugin option is planned), enter the same name + secret on crew phones, and put the channel name in the plugin's telemetry settings.
5. **Add crew**: have each crew phone send an advert; their node appears in the plugin's node picker. Assign role `crew`. Crew nodes can then use commands, and receive alerts.
6. **Private crew positions** (optional): on each crew phone, open the SK-DEV contact's **permissions** and grant **telemetry** (including location). Enable `poll_crew_positions` in the plugin. Crew positions arrive encrypted and appear as vessels in Signal K — only nodes you've configured are plotted ("favorites only"), never the whole mesh.

## Telemetry line format

Pipe-delimited, self-describing units, max 133 chars (the multi-hop-safe MeshCore payload floor). The MeshCore app timestamps every message, so no date/time is embedded.

| Segment | Example | Notes |
|---|---|---|
| name | `VESSEL` | optional (`includeVesselName`) |
| temperature | `87.4F` | outside |
| humidity | `65%RH` | outside |
| pressure | `1019mb` | barometric |
| wind | `42S(E) 7.5k gusts 11k` | see below |
| depth + anchor | `Depth 12.6FT Dist 98FT` | depth below surface; `Dist` = horizontal distance from bow to the anchor drop position (from signalk-anchoralarm-plugin), shown only when anchored |
| house bank | `SOC 97% 13.3V +6.2A` | current signed: + charging, − discharging |

Fields with no data are omitted.

### Wind: how to read it, and the measurement window

`42S(E) 7.5k gusts 11k` reads: apparent wind 42° off the bow on the **s**tarboard side, blowing from the **E**ast (8-point compass), 7.5 knots, gusting 11.

- **Speed** is the **median** of 1-second samples accumulated since the last successful push — i.e. over one push interval (default 15 minutes). **Gusts** is the maximum sample in that same window, shown only when it exceeds the median by ≥ 2 kn. The buffer clears only after a successful push; the `wx` pull verb reads it non-destructively.
- The **compass point in parentheses** places the bow-relative apparent angle on the compass rose using the vessel's heading (`headingTrue`, or `headingMagnetic` + variation). At rest (mooring/anchor, no boat speed) apparent wind equals true wind, so the point is exact; under way it is an estimate. Without a heading source the segment degrades to `42S 7.5k`.
- `windSource` is configurable: `apparent` (above) or `true`, which renders compass-point-first: `E 7.5k gusts 11k`. Pick whichever your boat's paths genuinely carry — on many setups `directionTrue` is mislabeled apparent data; check before trusting it.

## Venus OS / Cerbo GX install notes

Validated live on a Cerbo GX (Venus OS v3.73 Large, Signal K 2.19.1, Node 20, Heltec V4 on USB):

- **serial-starter will fight you for the radio.** Venus probes every new USB serial device with its own drivers (`gps-dbus`, `vedirect-interface`); two owners on the port wedge the radio. Tell it to ignore Espressif devices (vendor `303a`) before plugging the radio in:
  ```
  echo 'ACTION=="add", ENV{ID_BUS}=="usb", ENV{ID_VENDOR_ID}=="303a", ENV{VE_SERVICE}="ignore"' >> /etc/udev/rules.d/serial-starter.rules
  udevadm control --reload-rules
  ```
  That file is overwritten by firmware updates — re-apply it from `/data/rc.local` (create it executable if absent, add the same two commands guarded by a `grep -q 303a || ...`). If services already latched on, `svc -d /service/gps-dbus.ttyACM0 /service/vedirect-interface.ttyACM0`, then replug the radio.
- **Install** from the Signal K config dir: `cd /data/conf/signalk && npm install signalk-meshcore`. The Cerbo needs internet for this step. serialport's armv7 prebuilds load fine; Node 20 (Venus-bundled) is supported.
- **Radio appears as `/dev/ttyACM0`** (`cdc_acm`, native USB). Restart Signal K with `svc -t /service/signalk-server`.
- **Radio GNSS (optional):** the Heltec V4 has a connector for an external GNSS module (NEO-6M/M8N). If fitted, enable it once via the device setting `gps:1` (MeshCore custom var), then turn on `radio_gnss_fallback` in the plugin — when the boat's position source goes stale, the plugin polls the radio's GPS locally (no airtime) and injects the fix into Signal K. A below-decks radio can still get a fix (verified), but mounting and hull material matter.
- **Retire competing senders.** If you migrated from signalk-meshtastic, disable it; and check root's crontab and Node-RED for legacy automations that inject alarm-state notifications — this plugin forwards every `alarm`/`emergency` notification to crew, so a forgotten status-summary cron becomes a quarter-hourly text barrage.

## Notes from hardware testing

- The radio's clock is wrong after every power cycle; the plugin syncs it on every connect.
- Messages received while the server is down are queued on the radio and processed on the next connect.
- The serial port is single-owner: while the plugin is connected, the MeshCore web client can't also use the radio (and vice versa). Two simultaneous owners can wedge the radio's USB until replugged.
- The companion serial protocol is strict request/response; the plugin serializes all radio commands internally with timeouts (do not be alarmed by occasional `radio command timed out` debug lines on a busy mesh — the queue recovers).
- Host USB suspend (e.g. a laptop dev rig going to sleep) can leave the serial connection open but dead, with no disconnect event. The plugin detects this — 5 consecutive command timeouts force a reconnect — but the radio's USB interface can also wedge hard enough to need a physical replug. On a desk rig, prevent host sleep (`caffeinate` on macOS); on Venus OS this doesn't apply.
- Repeater relaying in MeshCore is a firmware role, not a per-contact behavior; the plugin needs no routing configuration. A masthead repeater node is a good way to bridge a below-decks radio to the wider mesh.

## On-boat validation checklist (pre-release)

- [ ] Venus OS Large: bundled Node version vs `engines` (>=22); `cdc_acm` driver presents the radio as `/dev/ttyACM*`; `serialport` prebuilds load on ARM (TCP fallback otherwise)
- [ ] path-mapper aliases present for all telemetry paths; values sane vs instruments
- [ ] genuine GNSS fix on the bus before enabling `send_position` / `pos`
- [ ] wind source setting matches what the boat's paths actually carry (true vs apparent)
- [ ] switch name→path mapping against the real N2K switch bank
- [ ] push interval vs regional duty-cycle norms
- [ ] telemetry channel + secret distributed to crew phones
- [ ] multi-day soak

## License

GPL-3.0-only. Derived from signalk-meshtastic © Henri Bergius, also GPLv3. See LICENSE.
