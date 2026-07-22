# Design — In-plugin channel management (Tier 3 UX)

**Status:** `[PROPOSED — not approved, not scheduled]`. Post-v1 enhancement.
**Motivation:** creating the private telemetry channel on the radio and mirroring its secret to crew is the single biggest install cliff (see README "Creating the private telemetry channel"). Today it requires the MeshCore web client and manual secret copying. Removing this step is what most moves the plugin from *expert-installable* to *boat-owner-installable*.

---

## 1. Problem

The plugin pushes telemetry to a named channel that must already exist on the radio with a shared 128-bit secret. There is no way to create, view, or share that channel from the plugin. A new user must:
1. Connect the radio to a separate MeshCore client.
2. Create a channel + generate a secret there.
3. Manually copy name + secret to each crew phone.
4. Type the name back into the plugin.

Every step is off-plugin and error-prone (the "same secret, not just same name" gotcha is the most common failure).

## 2. Goal / non-goals

**Goal:** let the user create and share the telemetry channel from the plugin's own config UI — generate a secret, write the channel to the radio, and surface the name + secret (and ideally a QR/shareable form) for crew.

**Non-goals:** managing *arbitrary* channels or acting as a general MeshCore admin console; changing the Public channel; multi-channel telemetry. One managed telemetry channel is the scope.

## 3. Verify before building `[OPEN — gates implementation]`

The whole feature depends on meshcore.js exposing channel create/read over the companion protocol. **Confirm on the target runtime before designing further:**

```
node -e "const {Connection}=require('@liamcottle/meshcore.js'); \
  ['setChannel','getChannel','getChannels','addChannel','setChannelSecret'] \
  .forEach(m => console.log(m, typeof Connection.prototype[m]))"
```

- If create/set-channel methods exist → Option A: drive them directly (through `queue.run`, per the serialize-all-radio-commands rule).
- If only read exists → Option B: document that the plugin can *verify/display* the channel but not create it; creation stays external. Still a UX win (shows the user the secret to mirror, validates the match).
- If neither → feature is not feasible on this library version; revisit on upgrade.

The companion protocol's channel commands and their frame formats must be read from the meshcore.js source and (ideally) the MeshCore firmware, not assumed.

## 4. Proposed UX

New **Channel** settings group (or an action button in Channel messages):
- **"Generate telemetry channel"** — creates a random 128-bit secret, writes the channel to the radio under the configured name, and stores/display the secret.
- **Display** the active channel name + secret (masked, with reveal) so the user can mirror it to crew — plus a copyable string and, if feasible offline, a QR encoding the name+secret for phone import.
- **"Verify channel"** — read the channel back from the radio and confirm name+secret match what's configured; surface a clear pass/fail in the status line (ties into the Tier-2 diagnostic status work).

Secret handling: the secret is sensitive. Store it in plugin config (already how the channel is used), never log it, mask it in the UI by default.

## 5. Technical shape (if Option A viable)

- New module `plugin/channels.js` — thin adapter over meshcore.js channel calls, all routed through `queue.run` (spec: radio commands serialize or the bot goes deaf).
- `index.js` — a config action handler that generates the secret (`crypto.randomBytes(16)`), calls the adapter to write the channel, persists via `savePluginOptions`, and re-reads to verify.
- Status/diagnostic: extend the Tier-2 `setupWarnings` to include "channel secret mismatch" once verify is available.
- Tests: secret generation, adapter routes through the queue, verify pass/fail, no secret in logs.

## 6. Effort `[ESTIMATE]`

Adapter + config action + verify + tests: ~1–1.5 days *if* Option A (create methods exist). Option B (verify/display only): ~0.5 day. Gated entirely on §3.

## 7. Open items

1. **§3 API check** — run on the Cerbo; determines Option A vs B vs infeasible. **Blocks everything.**
2. QR generation offline (no CDN — must bundle a tiny QR encoder or skip).
3. Whether to also import crew-side (probably out of scope — crew use their own phone app).
4. Secret rotation / re-generation semantics (regenerate = crew must re-mirror; warn clearly).
