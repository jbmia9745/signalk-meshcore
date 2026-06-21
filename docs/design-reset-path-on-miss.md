# Design — Auto Reset-Path on Delivery Failure (`device.js`)

**Status:** `[PROPOSED]` — for review. No code written yet.
**Author:** engineering agent · **Date:** 2026-06-20
**Scope:** `plugin/device.js` (primary), `plugin/index.js` (config wiring), `test/device.test.js` (coverage).

---

## 1. Problem statement `[VERIFIED]`

When a contact's learned direct path goes stale (a repeater in the path moves or is decommissioned), DMs to that contact fail and **nothing in our stack heals the path automatically.** Verified this session across all three layers:

- **Companion firmware:** `MyMesh::onSendTimeout()` is empty (`reference/MeshCore/examples/companion_radio/MyMesh.cpp:853`). On a direct-send timeout the radio does nothing — no retry, no `resetPathTo`, no flood fallback. `resetPathTo` (`BaseChatMesh.cpp:791`) is only ever called via the host `ResetPath` command.
- **meshcore.js:** `resetPath()` exists (`connection.js:1376`) but is never auto-invoked; `sendTextMessage` sends once with `attempt=0` and does no fallback.
- **Our plugin (`device.js`):** on a missed ack, `onMiss` only re-sends the **same** message down the **same** dead path up to `dm_retries` times, then stops (device.js:67-79).

The self-heal described in MeshCore FAQ Q5.3 ("the app will reset the path and send as flood on the last retry by default") lives **only in the phone/T-Deck app**. A headless bot (DDRM) never gets it.

**Observed impact (this session):** Crew1's path was pinned through the decommissioned `DDRM Repeater` (`outPathLen=3`, first hop `37`). Every pong/telemetry poll failed (`NO DELIVERY CONFIRMATION`, `Crew telemetry poll failed`) and the path persisted until a **manual** `ResetPath` (`3 → -1`) was issued over SSH. This has now required manual intervention three times.

---

## 2. Goal / non-goals

**Goal:** When all delivery retries for a DM are exhausted with no confirmation, automatically reset that contact's stored path on the radio so the **next** message floods and re-learns a fresh path — replicating the phone app's default behavior for the headless bot.

**Non-goals (v1):**
- No change to channel/push sends (channels always flood; no per-contact path — verified faq.md Q5.5).
- No immediate re-send after reset (the next naturally-occurring DM/poll floods and relearns; avoids airtime + complexity). *Optional toggle in §6.*
- No multi-path storage or "best path" selection (firmware itself defers this; out of scope).
- No change to `dm_retries` / `dm_retry_gap_seconds` semantics.

---

## 3. Verified basis (protocol facts the design relies on)

| Fact | Source (read this session) |
|---|---|
| `resetPath(pubKey)` clears the contact's `out_path_len → OUT_PATH_UNKNOWN` | meshcore.js `connection.js:1376`; firmware `BaseChatMesh.cpp:791-792` |
| After reset, next DM is sent flood (`sendFloodScoped`, `MSG_SEND_SENT_FLOOD`) | `BaseChatMesh.cpp:437-440` |
| Path relearns from the path-return packet, unconditional replace | `BaseChatMesh.cpp:316-319` (`onContactPathRecv`) |
| Delivery confirmation = `SendConfirmed` push matched by `expectedAckCrc` | `device.js:34-65`; spec §10 fact 7 |
| Every radio command MUST go through the FIFO queue (global-event response matching cross-talks otherwise) | spec §11; `queue.js` |
| `resetPath` is a radio command (resolves on `Ok`/`Err`) → must be queued | `connection.js:1376-1404` |

---

## 4. Use cases

### UC-1 — Stale path self-heals (primary)
1. Crew1's stored path runs through a now-dead repeater.
2. Plugin sends a DM (pong / telemetry reply / alert) to Crew1.
3. No `SendConfirmed` within the ack window; `onMiss` fires.
4. Retries (`dm_retries`) re-send down the same path; all miss.
5. **NEW:** on the *final* miss, plugin calls `resetPath(Crew1)` (queued). Logs `PATH RESET <contact> after N failed attempts`.
6. Next DM/poll to Crew1 floods → Crew1 path-returns → fresh path stored (via new repeater, e.g. DDRM RPTR).
7. Subsequent DMs deliver directly. **No human intervention.**

### UC-2 — Transient loss, no needless reset
1. DM to Crew1; first attempt misses (RF fade).
2. A retry within `dm_retries` delivers (`SendConfirmed` arrives).
3. `onConfirm` cancels the timer; **no reset** (path was fine). Existing behavior preserved.

### UC-3 — Contact genuinely offline
1. Crew1 powered off / out of range.
2. DM + retries all miss → final miss → `resetPath(Crew1)` → `outPathLen -1`.
3. Next send floods, still no delivery (contact down). Path stays `-1`.
4. **Acceptable:** `-1` is the correct "unknown" state; it relearns whenever Crew1 returns. No worse than before, and no stale path left behind.

### UC-4 — Feature disabled (operator opt-out)
1. `reset_path_on_failure = false` in config.
2. Final miss → log `NO DELIVERY CONFIRMATION` only; **no reset** (today's behavior). Mirrors the FAQ's "can be turned off in settings."

### UC-5 — Reset command itself fails
1. Final miss → `resetPath(Crew1)` enqueued.
2. Radio returns `Err`, or queue times out.
3. Plugin logs `PATH RESET FAILED <contact>: <reason>` and continues. No crash, no queue wedge (15s queue timeout protects it).

### UC-6 — Channel/push send (out of scope, must be unaffected)
1. Telemetry push to Vessel_Comm misses (channels have no ack anyway).
2. `sendChannelText` has no `trackDelivery`, no `onMiss` → reset logic never engages. Verified: channel path untouched.

---

## 5. Functional design

**Trigger:** the *terminal* miss — i.e. `trackDelivery`'s timeout fires AND there are no retries left (`attempt >= DM_RETRIES`). Today that's exactly the branch where `onMiss` is `null`. We replace "do nothing" with "reset the path."

**Action:** call a queued `resetPath(to)` once. `to` is the contact public key already held by `sendDm`.

**Idempotence / storm control:** reset only fires on the final miss of a send chain (one reset per failed DM chain, not per attempt). If multiple independent DMs to the same dead contact each fail, each will reset — but reset is idempotent (`-1 → -1`) and cheap (local-ish radio command), so no special dedupe needed in v1. *(Note in §8 if we later want a per-contact cooldown.)*

**Logging (operator-visible, debug stream):**
- Success: `PATH RESET <contactHexPrefix> after <N> failed attempts — next send will flood`
- Failure: `PATH RESET FAILED <contactHexPrefix>: <message>`

**Config gate:** new boolean `reset_path_on_failure`, **default `true`** (matches phone-app default per FAQ Q5.3; the whole point is the bot should behave like the app). Operator can disable.

---

## 6. Technical design

### 6.1 `device.js` changes

**New options** (read in `makeDevice`, like `dmRetries`):
```
const RESET_PATH_ON_FAILURE =
  !opts || opts.resetPathOnFailure !== false;   // default true
```

**New internal helper** (queued, never throws to caller):
```
const resetPath = (to) => queue.run(
  () => connection.resetPath(to),
  'resetPath',
).then(
  () => { if (log) log(`PATH RESET ${hex6(to)} — next send will flood`); },
  (e) => { if (log) log(`PATH RESET FAILED ${hex6(to)}: ${e && e.message ? e.message : e}`); },
);
```
- `hex6(to)` = first 6 bytes of the key as hex, for log readability (matches how contacts are referenced elsewhere).
- Goes through `queue.run` — **non-negotiable** per spec §11. Label `'resetPath'` for queue tracing.
- `.then(onOk, onErr)` swallows rejection so a failed reset can't reject up into `trackDelivery`'s timer callback.

**Modify `sendDm`'s `onMiss` construction** — the only behavioral change:
```
.then((sent) => trackDelivery(
  sent,
  attempt ? `dm retry ${attempt}` : 'dm',
  attempt < DM_RETRIES
    ? () => { setTimeout(() => sendDm(text, to, attempt + 1), RETRY_GAP_MS); }   // more retries left
    : (RESET_PATH_ON_FAILURE ? () => resetPath(to) : null),                       // FINAL miss → reset
));
```
That is the entire core change: the previously-`null` terminal `onMiss` becomes an optional path reset.

**No change** to: `clamp`, `MAX_TEXT`, `note`, `trackDelivery` body, `sendChannelText`, `getSelfTelemetry`, the queue, or the public API surface (`sendText(text, to)` unchanged).

### 6.2 `index.js` wiring
- Pass the new opt where `makeDevice` is constructed (alongside `dmRetries`/`retryGapSeconds`, index.js:566-567):
  ```
  resetPathOnFailure: (settings.communications || {}).reset_path_on_failure,
  ```
- Add to the plugin config schema (near `dm_retries`, index.js:948):
  ```
  reset_path_on_failure: {
    type: 'boolean',
    title: 'Auto-reset a contact\'s route after repeated delivery failures (next message floods to relearn the path). Mirrors the MeshCore app default.',
    default: true,
  }
  ```

### 6.3 Control flow (final-miss path)
```
sendDm(text, to, attempt=DM_RETRIES)
  └─ sendTextMessage (queued)  → expectedAckCrc
       └─ trackDelivery: wait waitMs for SendConfirmed(crc)
            ├─ confirmed → log DELIVERED, cancel timer            [UC-2]
            └─ timeout   → log NO DELIVERY CONFIRMATION
                            onMiss():
                              if RESET_PATH_ON_FAILURE → resetPath(to)  (queued)  [UC-1/3]
                              else nothing                                          [UC-4]
                                resetPath: Ok → log PATH RESET                      [UC-1]
                                           Err/timeout → log PATH RESET FAILED      [UC-5]
```

### 6.4 Failure / edge handling
- **Queue timeout on resetPath:** `queue.run` enforces the 15s timeout; rejection is caught by the `.then(,onErr)` and logged. Queue not wedged.
- **`expectedAckCrc` absent** (e.g. send returned no ack info): `trackDelivery` returns early (device.js:35) → `onMiss` never scheduled → no reset. Same as today; acceptable (nothing to confirm against).
- **Reconnect mid-chain:** if the connection drops, queued commands fail/clear on reconnect; reset simply won't run. Path stays as-is; next session's failures will trigger it. No special handling.
- **`unref` on timer:** unchanged; reset is scheduled from inside the existing timer callback, no new long-lived timers.

---

## 7. Test plan (`test/device.test.js`)

Existing tests use a mock `connection` + mock `queue`. Add:

| Test | Asserts |
|---|---|
| T1 — final miss, default on | after retries exhausted + timeout, `connection.resetPath` called once with `to` |
| T2 — delivered, no reset | `SendConfirmed` within window → `resetPath` NOT called (UC-2) |
| T3 — non-final miss | miss with retries remaining → schedules retry, `resetPath` NOT called |
| T4 — disabled | `resetPathOnFailure:false` → final miss → `resetPath` NOT called (UC-4) |
| T5 — reset goes through queue | `queue.run` invoked with label `'resetPath'` (spec §11 guard) |
| T6 — reset failure swallowed | `connection.resetPath` rejects → no unhandled rejection, failure logged (UC-5) |
| T7 — channel send unaffected | `sendChannelText` miss path never calls `resetPath` (UC-6) |

Run: `npm test` (currently 41 passing; target all green + new cases). Lint: `npx eslint .` (airbnb-base).

---

## 8. Open items for your decision `[OPEN]`

1. **Default value** — proposed `true` (match app behavior). Confirm you want it on by default, or ship off and opt-in.
2. **Active re-send after reset?** v1 does *not* immediately resend; it lets the next natural message flood/relearn. Alternative: after reset, immediately resend the failed text (guarantees that specific message gets a flood attempt). Costs airtime + complexity. **Recommend: no resend in v1.** Your call.
3. **Per-contact reset cooldown** — not in v1 (reset is idempotent). Add later only if a flapping contact causes log spam.
4. **Scope to DMs only** — confirmed: channels excluded by design. No action needed; noting for the record.

---

## 9. Effort `[ESTIMATE]`
- `device.js` change: ~15 lines. ~1 hr incl. care.
- `index.js` wiring + schema: ~10 lines. ~30 min.
- Tests (7 cases): ~2 hrs.
- Lint/manual review: ~30 min.
**Total ~0.5 day.** No hardware required to land + unit-test; on-boat verification folds into Phase 5 soak.
