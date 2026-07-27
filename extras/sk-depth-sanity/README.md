# sk-depth-sanity

Tiny standalone Signal K plugin that nulls implausible depth values before
they enter the data model.

## Why

Some depth instruments (observed: a Raymarine unit, N2K PGN 128267) emit raw
`0xFFFFFFFC` when the sounder loses bottom lock — a "no reading" sentinel.
canboat nulls the *standard* sentinels (`0xFFFFFFFF` not-available,
`0xFFFFFFFE` error) but this variant passes through as **42,949,672.92 m**
(~140,911,006 ft), which then reaches every consumer: displays, dashboards,
alert rules, and anything (like [signalk-meshcore](../../README.md)) that
relays telemetry. Field incident 2026-07-26.

## What it does

Registers a delta input handler (`app.registerDeltaInputHandler`) and rewrites
any `environment.depth.*` numeric value above a plausibility limit
(default **1000 m**, configurable) to `null` — which is what the instrument
meant. Everything else passes through untouched. Disabling the plugin reverts
the handler to a passthrough (the server offers no unregister).

## Install

This is a separate plugin, not part of signalk-meshcore. Copy the directory
into your server's `node_modules` and enable it:

```sh
cp -r extras/sk-depth-sanity <signalk-config-dir>/node_modules/
```

Then enable it in the admin UI (Server → Plugin Config → "Depth sanity
filter"), or write `<signalk-config-dir>/plugin-config-data/sk-depth-sanity.json`:

```json
{ "enabled": true, "configuration": { "maxDepthMeters": 1000 } }
```

and restart the server once.

## Test

```sh
node --test extras/sk-depth-sanity/test.js
```
