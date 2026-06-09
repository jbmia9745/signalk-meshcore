# signalk-meshcore

Signal K plugin for interfacing with the [MeshCore](https://meshcore.co.uk/) LoRa mesh network.

**Status: in development, not yet released.**

Connects a Signal K server to a MeshCore Companion radio over TCP/WiFi or USB serial, providing:

- Text alerts from Signal K notifications to crew MeshCore nodes (MOB alerts degrade to a text message with lat/lon — MeshCore has no waypoint concept).
- A text command bot: `ping`, digital switching (`turn <switch> on|off`), and telemetry query verbs (`wx`, `batt`, `pos`, `depth`, `status`, `help`).
- Scheduled boat-telemetry push to a MeshCore channel as a compact one-line text message, in Imperial/SAE units (°F, %, inHg, knots, feet).
- Position-sharing MeshCore nodes shown as vessels in Signal K; boat position out via MeshCore adverts.

This is a port of [signalk-meshtastic](https://github.com/meri-imperiumi/signalk-meshtastic) by Henri Bergius (GPLv3) to the MeshCore platform, using [@liamcottle/meshcore.js](https://github.com/meshcore-dev/meshcore.js) (MIT). It is a re-platform, not a transport swap: MeshCore's contact-based routing replaces Meshtastic's packet subscriptions, identity is keyed on public keys instead of node numbers, and native structured telemetry is replaced by bot-style text messaging.

## Prerequisites

- A MeshCore Companion radio reachable over TCP/WiFi or USB serial. (No HTTP transport — if you used HTTP with a WiFi node, use TCP.)
- Telemetry fields read the canonical Signal K paths `electrical.batteries.house.*`, `environment.outside.*`, and `environment.wind.*`. On many installations (e.g. Victron Venus OS) these only exist if a plugin such as [signalk-path-mapper](https://www.npmjs.com/package/signalk-path-mapper) aliases the raw device-instance paths to the canonical names. Configure that first; this plugin does not read numeric battery instances.

## License

GPL-3.0-only. Derived from signalk-meshtastic © Henri Bergius, also GPLv3. See LICENSE.
