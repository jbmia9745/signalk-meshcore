# signalk-meshcore

Signal K plugin for interfacing with the [MeshCore](https://meshcore.io/) LoRa mesh network.

**Status: validated live aboard (Venus OS / Cerbo GX, real N2K data, multi-hour field testing); multi-day soak in progress before first npm release.**

Connects a Signal K server to a MeshCore Companion radio over USB serial or TCP/WiFi, providing:

- **Telemetry bot** — a compact, human-readable boat-status line pushed to a private MeshCore channel on an interval:
  `VESSEL | 87.4F | 65%RH | 1019mb | 42S(E) 7.5k gusts 11k | Depth 12.6FT Dist 98FT | SOC 97% 13.3V +6.2A`
- **Pull verbs** — DM the boat `wx`, `batt`, `pos`, `depth`, `status`, `help`, or `ping` and get an answer.
- **Digital switching** — crew DM `turn <switch> on|off`, with switch names mapped to real Signal K paths (N2K bank paths supported).
- **Alerts** — Signal K `alarm`/`emergency` notifications go to crew as DMs and optionally to a channel (field-measured at ~25 ms from notification to radio). `normal`-state clears are deliberately not forwarded. MOB notifications degrade to a text alert with lat/lon (MeshCore has no waypoints).
- **Crew positions, privately** — the plugin polls crew nodes' telemetry (encrypted, contact-to-contact) and plots them as vessels in Signal K/Freeboard. No broadcast of crew location required.
- **Boat position out, two ways** — broadcast via MeshCore adverts (optional, off by default), or privacy-first: leave the broadcast off and grant individual contacts telemetry permission on the radio, so only they can pull the boat's location.
- **Radio GNSS fallback** — with a GPS module on the radio, the plugin detects a stale boat position source and transparently fills `navigation.position` from the radio's own GNSS (field-tested across a real 66-minute GPS outage), handing back automatically when the boat source returns.

This is a port of [signalk-meshtastic](https://github.com/meri-imperiumi/signalk-meshtastic) by Henri Bergius (GPLv3) to the MeshCore platform, using [meshcore.js](https://github.com/meshcore-dev/meshcore.js) (MIT). It is a re-platform, not a transport swap: MeshCore's contact-based routing replaces packet subscriptions, identity is keyed on public keys, and native structured telemetry is replaced by bot-style text (the MeshCore companion protocol has no host-injected telemetry — verified against firmware v1.16 source).

## Requirements

- **Boat radio — the only hardware choice that matters to this plugin**: it's the device wired to the Signal K server, so its USB/serial behavior, power draw, and optional GNSS module are what the plugin (and this document's hardware notes) depend on. Development and validation were done on the **Heltec WiFi LoRa 32 V4**, and every hardware note here (power budgets, GPS wiring, USB behavior) is V4-specific. Other MeshCore-supported boards should work over the same companion protocol but are **untested here** — if you don't want to debug hardware yourself, use the V4 as the boat node. Flash **canonical MeshCore Companion firmware ≥ 1.15** from [flasher.meshcore.io](https://flasher.meshcore.io):
  - `companion_radio_usb` for USB serial (recommended; data + power over one cable), or
  - `companion_radio_wifi` for TCP — note this variant is a source build with WiFi credentials as compile-time flags; it is not in the release flasher.
  - The MeshOS fork's unified firmware is untested and unsupported.
  - **Crew devices and repeaters can be any MeshCore hardware** — the plugin only ever sees them as mesh contacts, never touches their hardware. The validation boat's crew ran a RAK WisMesh Tag and a Heltec V4 interchangeably; the rig repeater was a RAK4631.
- **Node.js ≥ 20** (validated on Venus OS's bundled Node 20; upstream signalk-meshtastic requires ≥ 22).
- **Signal K paths**: telemetry reads the canonical paths `electrical.batteries.house.*`, `environment.outside.*`, `environment.wind.*`, `environment.depth.belowSurface`, `navigation.anchor.distanceFromBow`. On Venus OS and similar, these may only exist if [signalk-path-mapper](https://www.npmjs.com/package/signalk-path-mapper) (or equivalent) aliases the raw device-instance paths. The plugin never reads numeric battery instances — only `house`.

## Setup walkthrough

1. **Flash the radio** (Chrome/Edge, [flasher.meshcore.io](https://flasher.meshcore.io)): Companion USB, ≥1.15. Set the regional frequency preset to match your local mesh (e.g. USA/Canada 910.525 MHz / 62.5 kHz / SF7 / CR5).
2. **Install the plugin** from the Signal K AppStore (or `npm install signalk-meshcore` in your server's config dir).
3. **Configure the connection**: transport `serial` + the device path (e.g. `/dev/ttyACM0` — the radio is native USB CDC), or `tcp` + host (port 5000).
4. **Create a private telemetry channel**: never push telemetry to Public — it is a live regional channel. Create a named channel with a random 128-bit secret on the radio (the MeshCore web client over USB can do this, as can a short script; an in-plugin option is planned), enter the same name + secret on crew phones, and put the channel name in the plugin's telemetry settings.
5. **Add crew**: have each crew phone send an advert; their node appears in the plugin's node picker. Assign role `crew`. Crew nodes can then use commands, and receive alerts.
6. **Private crew positions** (optional): on each crew phone, open the boat radio's contact card → **permissions** and grant **telemetry** (including location). Enable `poll_crew_positions` in the plugin. Crew positions arrive encrypted and appear as vessels in Signal K — only nodes you've configured are plotted ("favorites only"), never the whole mesh.

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

### The three name knobs (don't conflate them)

| What | Where set | What it affects |
|---|---|---|
| **Node name** (e.g. `DDRM:` before channel messages) | on the radio (MeshCore setting) | sender attribution the protocol prepends to every channel message — not removable by the plugin |
| **Vessel name** (the optional line prefix) | plugin settings: "Include vessel name" + name field | the telemetry line body. Checkbox off = no name. Checkbox on with an **empty** name field falls back to the Signal K server's vessel name — set the field explicitly if those differ |
| **Channel name** (e.g. `Vessel_Comm`) | on the radio (and as a local label on each phone) | which channel the plugin pushes to (`channelName` must match the radio's). Channels are *identified by their secret* — names are local labels, so renaming on one device doesn't break others |

### Wind: how to read it, and the measurement window

`42S(E) 7.5k gusts 11k` reads: apparent wind 42° off the bow on the **s**tarboard side, blowing from the **E**ast (8-point compass), 7.5 knots, gusting 11.

- **Measurement follows the WMO standard** and is independent of the push interval: **speed** is the mean of 1-second samples over a rolling **10-minute** window; **gusts** is the highest **3-second average** within that window, shown only when it exceeds the sustained speed by ≥ 2 kn (a single 1-second spike doesn't qualify). Pushes and pull verbs both read the same rolling window, so an hourly push still reports 10-minute wind, not an hour-long smear.
- The **compass point in parentheses** places the bow-relative apparent angle on the compass rose using the vessel's heading (`headingTrue`, or `headingMagnetic` + variation). At rest (mooring/anchor, no boat speed) apparent wind equals true wind, so the point is exact; under way it is an estimate. Without a heading source the segment degrades to `42S 7.5k`.
- `windSource` is configurable: `apparent` (above) or `true`, which renders compass-point-first: `E 7.5k gusts 11k`. Pick whichever your boat's paths genuinely carry — on many setups `directionTrue` is mislabeled apparent data; check before trusting it.

## Venus OS / Cerbo GX install notes

Validated live on a Cerbo GX (Venus OS v3.73 Large, Signal K 2.19.1, Node 20). The boat node in the validated setup is a **Heltec V4 running `companion_radio_usb` firmware, plugged directly into the Cerbo GX's USB port** — one cable carries both power and data, no battery, no BLE/WiFi variant involved. The Cerbo's USB port powered the radio through the entire validation including transmit peaks (mind the TX brownout note below if you power it any other way):

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

- **Underpowered USB causes TX brownouts** that masquerade as software bugs: the Heltec V4 draws ~1 A peaks when transmitting (more on the 28 dBm variant), and a weak supply (USB-A ports/cables especially) reboots the radio on every send. Symptoms: receive works fine, every ping/advert/send fails, companion apps throw BLE write exceptions mid-operation. Use a USB-C source that can actually deliver, or drop TX power to test. The same math applies when powering from a Cerbo GX data port — budget for the TX peak, not the idle draw.

- The radio's clock is wrong after every power cycle; the plugin syncs it on every connect.
- Messages received while the server is down are queued on the radio and processed on the next connect.
- The serial port is single-owner: while the plugin is connected, the MeshCore web client can't also use the radio (and vice versa). Two simultaneous owners can wedge the radio's USB until replugged.
- The companion serial protocol is strict request/response; the plugin serializes all radio commands internally with timeouts (do not be alarmed by occasional `radio command timed out` debug lines on a busy mesh — the queue recovers).
- Host USB suspend (e.g. a laptop dev rig going to sleep) can leave the serial connection open but dead, with no disconnect event. The plugin detects this — 5 consecutive command timeouts force a reconnect — but the radio's USB interface can also wedge hard enough to need a physical replug. On a desk rig, prevent host sleep (`caffeinate` on macOS); on Venus OS this doesn't apply.
- **Recommended topology: below-decks radio + rig-mounted repeater.** The boat radio lives at the server (below decks, USB power and data) where its RF reach is poor; a MeshCore repeater hoisted in the rig bridges it to the world. It doesn't need the masthead: the validation boat flies a RAK4631 at ~35 ft on a spreader flag halyard — hoistable and serviceable from the deck — and field measurements showed every multi-hop echo of the boat's transmissions reaching shore repeaters *via the rig repeater*; no shore station heard the below-decks radio directly. Repeater relaying is a firmware role, not per-contact behavior; the plugin needs no routing configuration, doesn't talk to the repeater, and any MeshCore repeater hardware works. Repeaters are administered remotely over the mesh (login + CLI from the phone app), so once hoisted it never needs hands on it.

## Operating over multi-hop links (field notes)

Validated working: crew at home exchanging commands with the boat across a metro mesh (4-hop floods, 3-hop directed circuits through municipal repeaters). What we learned getting there:

- **Replies wait for quiet air.** A reply transmitted immediately after an inbound exchange collides with that exchange's own RF wake (duplicate floods and ack echoes still relaying) and dies at marginal links — measured: identical messages failed at +50 ms and delivered in under 2 s when sent cold. The plugin holds command replies until the air has been free of inbound traffic for `reply_delay_seconds` (default 3, capped at 30 s of total hold), so a burst of commands gets all its answers instead of only the last one.
- **Delivery is logged end-to-end.** Every directed send logs `DELIVERED dm (round trip …ms)` when the recipient's ack arrives, or `NO DELIVERY CONFIRMATION` after the timeout — "did it actually get there?" is answered by the server log, not guesswork.
- **Alert storms are damped.** A flapping device alarm (e.g. a battery monitor hovering at its low-voltage threshold) repeats at most once per `alert_cooldown_minutes` (default 15) per condition; escalations and MOB always send. Field motivation: one flapping SmartShunt produced 259 channel posts in a night.
- **Paths are learned, but pinnable.** MeshCore stores one directed path per contact (the first flood copy to arrive sets it — not necessarily the best route). On marginal links it can pay to pin paths by hand from the app (path entries are the first byte of each repeater's public key, in transmit order). Mind link asymmetry: small handhelds often *hear* distant repeaters they cannot *reach* — uplink, not downlink, is usually the limit.
- **Floods are redundant, directed is efficient.** A channel push may arrive several times via different repeater chains (robustness, by design); a directed reply rides exactly one stored path and lives or dies by it.
- **Why retry spacing is a fixed interval, not adaptive (design note).** Three protocol facts shape this: (1) the success side is already event-driven — a delivery ack cancels retries instantly, and the ack wait itself is the radio's per-send `estTimeout`, which scales with path length; (2) MeshCore has **no per-hop acknowledgments** — repeaters don't ack relays, so there is nothing mid-path to query; the only per-hop observable is passively overhearing a repeater's retransmission, which is reliable for hop 1 and degrades to near-blind beyond hop 2 — too noisy to drive retry decisions; (3) field data shows losses cluster in **fade epochs lasting tens of seconds**, so the gap's job is to make the retry *later* (time diversity), not better informed — an "smarter but sooner" retry re-fires into the same fade. Hence: wait the full ack window, then a fixed, configurable gap.
- **Retries are configurable, and spacing them matters.** `dm_retries` (default 1) and `dm_retry_gap_seconds` (default 5) govern automatic re-sends of unconfirmed direct messages. Field loss-runs showed failures cluster in *time* (fade epochs lasting tens of seconds) rather than uniformly — a spaced retry samples different propagation. Measured on a 60%-per-attempt 4-hop path: 10/10 delivered with 5 retries at 5 s spacing (6 first-try, two messages needing attempts 4 and 5; 19 transmissions total, zero duplicate deliveries). The trade is latency — a deep retry chain can take ~80 s — against messages that never arrive. Retries are new packets at the mesh layer (fresh ack codes), so repeater dedup does not suppress them.
- **How to localize loss on a multi-hop path.** Three instruments, no extra hardware: (1) the boat radio hears *echoes* of its own directed sends being retransmitted — each echo's remaining-path bytes identify which repeater just relayed, so silence after hop N brackets the failure; (2) your own repeaters' status counters (`direct received` vs `direct sent`, before/after a known number of test frames); (3) numbered test messages, so the receiving end reports exactly which frames died. A worked example from validation: 10 numbered frames, first hop relayed 10/10, deliveries exactly matched the frames whose second-hop echo was heard — loss localized to one specific 12-mile hop, later fixed with a higher-power repeater.
- **Receive-error counters separate corruption from threshold loss.** A repeater whose `rx errors` counter stays flat while frames go missing is not decoding garbage — the frames never reached it at decodable strength. That distinction decides between "raise power/antenna" (threshold) and "find the interference" (corruption).
- **Instruments on your N2K bus can talk through this plugin.** Any device that raises an N2K alert (depth sounders' shallow alarms, chartplotter anchor watches) can surface as a Signal K `alarm` notification — which this plugin faithfully forwards to crew. If a mystery alert reaches your phone, check the instruments' own alarm menus, and keep Signal K's log retention large enough to attribute it (Venus default keeps only ~100 KB of logs).

## Anchor watch and the backup GPS

The radio-GNSS fallback exists for telemetry continuity, not drag detection: its normal cadence is one position per ~5 minutes at ~11 m granularity. **Standing procedure: anchor watch armed = boat GPS on** (1 Hz, full precision). If an anchor watch is active while the fallback is what's feeding position, the plugin: (1) raises one loud `alarm` notification — to Signal K apps and crew over the mesh — saying the watch is running on backup GPS, and (2) automatically polls the radio's GPS every 30 seconds instead (serial-only, no airtime) so a drag shows in ~half a minute rather than five. The alarm clears itself when the boat GPS resumes or the anchor is raised. A source-aware GPS-lost watchdog runs alongside: anchored on boat GPS, ~20 s of position silence raises an emergency; anchored on the backup, the same watchdog allows 90 s before alarming — so detection is tight when the source is fast and tolerant when it's the 30-second backup, automatically. Note also that anchor-alarm plugins with "no position received" watchdogs may complain about the fallback's update rate — another reason the boat GPS is the right source when it matters.

## Plugin settings layout

Settings are grouped into: **Telemetry** (vessel position out, radio-GNSS fallback, crew display in Signal K, crew position polls, digital switching), **Alerts** (forwarding, alert channel, storm cooldown), **Direct messages** (reply quiescence hold, retries, retry gap), and **Channel messages** (the telemetry push line: channel, interval, vessel name, wind source). Configs saved under the old single "Communications" section are still honored.

## Known issues / not yet implemented

- **Restart connect-churn**: each plugin/server restart can produce one or two quick disconnect/reconnect cycles (~35 s apart) before the session settles. Self-healing, under investigation (suspected ESP32 auto-reset on serial port close).
- **Digital switching** ships disabled with an empty switch map — mapping friendly names to your real switch-bank paths (and verifying the bank accepts PUTs) is a per-boat commissioning step.
- **In-plugin channel management** (create/rename channels from settings) is planned; today the channel must exist on the radio with the configured name.

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
