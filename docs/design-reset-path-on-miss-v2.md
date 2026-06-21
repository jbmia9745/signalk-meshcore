# Design v2 (Final Review) — Auto Reset-Path on Directed DM Delivery Failure

**Status:** `[PROPOSED]` — revised per senior-architect review (2026-06-20), submitted for FINAL review.
**Scope:** `plugin/device.js` (primary), `plugin/index.js` (config wiring + schema), `test/device.test.js`.
**Relationship to v1:** `docs/design-reset-path-on-miss.md` is v1 (no recovery resend, no cooldown). This file is the revision; it supersedes v1 on approval.

---

## 0. Response to architect review — all four required revisions

| # | Architect-required revision | Disposition |
|---|---|---|
| 1 | Add optional single-shot recovery resend after reset | **Adopted** — §5 step 8, §6.1 `sendRecoveryDm` |
| 2 | Recovery resend uses a short delay, not zero | **Adopted** — `reset_recovery_gap_seconds`, default 3 (§6.1) |
| 3 | Per-contact reset/resend cooldown in v1 | **Adopted** — `reset_path_cooldown_minutes`, default 10 (§5, §6.1) |
| 4 | Resolve reset API mismatch before coding | **RESOLVED — not a mismatch** (§3.1): installed `connection.resetPath(pubKey)` is a high-level wrapper that resolves on protocol `Ok`/`Err`. Architect's Blocker closed. |

Architect's three `[OPEN]` blockers, closed:
- *High-level `resetPath(pubKey)` exists in installed package?* — **Yes** (§3.1, `connection.js:1376-1404`, read this session).
- *If not, define local wrapper* — **Not needed** (Option A).
- *Is `sendCommandResetPath` alone sufficient / does it confirm protocol success?* — The high-level `resetPath` wraps it and resolves on `Ok`/`Err`, so we use the wrapper (which DOES confirm protocol response), not the raw frame writer. We never treat "frame written" as "reset accepted."

---

## 1. Problem statement `[VERIFIED]`

A contact's learned direct path goes stale when a repeater in it moves/decommissions; DMs then fail and **no layer of DDRM's stack heals the path** — verified this session:
- Firmware: `MyMesh::onSendTimeout()` empty (`reference/MeshCore/examples/companion_radio/MyMesh.cpp:853`); `resetPathTo` (`BaseChatMesh.cpp:791`) never called on timeout (`BaseChatMesh.cpp:946-949`).
- meshcore.js: `resetPath` exists but never auto-invoked; `sendTextMessage` sends once, no fallback.
- Plugin: `device.js` `onMiss` re-sends same msg/same path up to `dm_retries`, then stops.

Self-heal in faq.md Q5.3 ("the app will reset the path and flood… by default… can be turned off") is **app-layer only**. DDRM is headless → must do it in-plugin.

**Observed:** Crew1 pinned through decommissioned `DDRM Repeater` (`outPathLen=3`, hop `37`) → repeated delivery failures → manual ResetPath required (×3 this session, including a remote reset from home).

---

## 2. Goal / non-goals

**Goal:** On terminal directed-DM delivery failure, reset that contact's stored path (subject to per-contact cooldown) so the next directed send floods and relearns; then optionally fire ONE recovery copy of the failed DM after a short delay.

**Non-goals (explicit, preserved):** no change to channel sends or telemetry push; no multi-path selection; no firmware route changes; no queue bypass; no recursive recovery; no recovery for sends without `expectedAckCrc`; no crash / unhandled rejection from reset failure. Alerts benefit only incidentally (they are directed DMs to crew).

---

## 3. Verified basis

| Fact | Source (read this session) |
|---|---|
| **`connection.resetPath(pubKey)` resolves on `ResponseCodes.Ok`, rejects on `Err`** (high-level, not raw writer) | meshcore.js `connection.js:1376-1404` |
| `resetPath` internally calls `sendCommandResetPath` (frame writer) | `connection.js:1399 → 141` |
| `resetPath` has **no internal timeout** → wrap in `queue.run` (15s) | `connection.js:1376-1404`; `queue.js`; spec §11 |
| After reset, next DM floods | firmware `BaseChatMesh.cpp:437-440` |
| Path relearns via path-return packet, unconditional replace | `BaseChatMesh.cpp:316-319` |
| Delivery confirm = `SendConfirmed` matched by `expectedAckCrc` | `device.js:34-65` |
| All radio commands serialize through the FIFO queue | spec §11; `queue.js` |
| Existing alert-storm damper = precedent for per-contact cooldown | `index.js` alert history map |

### 3.1 Reset API — RESOLVED `[VERIFIED]`
Re-verified from installed source this session:
```js
resetPath(pubKey) {                       // connection.js:1376
  return new Promise(async (resolve, reject) => {
    const onOk  = () => { ...; resolve(); }
    const onErr = () => { ...; reject(); }
    this.once(ResponseCodes.Ok, onOk);
    this.once(ResponseCodes.Err, onErr);
    await this.sendCommandResetPath(pubKey);   // → :141 frame writer
  });
}
```
→ Use **Option A** (existing wrapper). It confirms on protocol `Ok`/`Err`. No internal timeout, so `queue.run` (15s) bounds it. `[OPEN, low-priority]` installed version string unreadable from laptop sandbox (spec records v1.13.0); confirm on Cerbo if desired — not a behavioral blocker.

---

## 4. Use cases
- **UC-1 Self-heal:** all retries miss → cooldown clear → reset → wait gap → one recovery send → fresh path relearned.
- **UC-2 Transient loss:** retry within `dm_retries` delivers → no reset (unchanged).
- **UC-3 Offline (first miss):** reset + recovery fire once → still fails → path stays `-1`, relearns on return.
- **UC-4 Offline (repeat in cooldown):** `PATH RESET SUPPRESSED`, no reset/resend.
- **UC-5 Disabled:** `reset_path_on_failure=false` → log miss only.
- **UC-6 Reset fails:** log `PATH RESET FAILED`, **no recovery resend**, no crash.
- **UC-7 Resend off:** reset only.
- **UC-8 No `expectedAckCrc`:** no track/reset/resend.
- **UC-9 Channel miss:** no reset logic engaged.
- **UC-10 Reconnect mid-op:** queue failure logged, no unhandled rejection.

---

## 5. Functional flow (terminal-miss handler)
```
trackDelivery timeout AND attempt >= dm_retries:
  1. log NO DELIVERY CONFIRMATION (terminal)
  2. if !reset_path_on_failure → stop
  3. if cooldown active for contact → log PATH RESET SUPPRESSED → stop
  4. markResetAttempt(contact)                 // cooldown timestamp
  5. queue resetPath(contact)
       Ok  → log PATH RESET
       Err → log PATH RESET FAILED → stop      // no recovery resend on failed reset
  6. if !resend_after_path_reset → stop
  7. wait reset_recovery_gap_seconds
  8. queue ONE recovery send; trackDelivery(onMiss=null)  // logging only, single-shot
  9. recovery NEVER retries/resets/resends
```
Defaults: `reset_path_on_failure=true`, `resend_after_path_reset=true`, `reset_recovery_gap_seconds=3`, `reset_path_cooldown_minutes=10`.

---

## 6. Technical design

### 6.1 `device.js` (contained here except config wiring + tests)
```
// new opts in makeDevice
const RESET_ON_FAIL   = !opts || opts.resetPathOnFailure   !== false; // default true
const RESEND_AFTER    = !opts || opts.resendAfterPathReset !== false; // default true
const RECOVERY_GAP_MS = 1000  * (opts?.resetRecoveryGapSeconds  ?? 3);
const COOLDOWN_MS     = 60000 * (opts?.resetPathCooldownMinutes ?? 10);
const resetAttempts   = new Map();                  // hex6(to) -> last ms
const nowMs = (opts && opts.nowMs) || (() => Date.now());   // injectable for tests

const hex6 = (to) => Buffer.from(to).slice(0, 6).toString('hex');
const shouldSuppressReset = (to) => {
  const last = resetAttempts.get(hex6(to));
  return last !== undefined && (nowMs() - last) < COOLDOWN_MS;
};
const markResetAttempt = (to) => resetAttempts.set(hex6(to), nowMs());

const resetPath = (to) => queue.run(() => connection.resetPath(to), 'resetPath').then(
  () => { log && log(`PATH RESET ${hex6(to)} after ${DM_RETRIES + 1} failed attempts`); return true; },
  (e) => { log && log(`PATH RESET FAILED ${hex6(to)}: ${e && e.message ? e.message : e}`); return false; },
);

const sendRecoveryDm = (text, to) => {
  note('dm recovery', text);
  return queue.run(
    () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
    'sendTextRecovery',
  ).then((sent) => trackDelivery(sent, 'dm recovery', null)); // onMiss=null → single-shot
};

const handleTerminalMiss = async (text, to) => {
  if (!RESET_ON_FAIL) return;
  if (shouldSuppressReset(to)) { log && log(`PATH RESET SUPPRESSED ${hex6(to)} — cooldown active`); return; }
  markResetAttempt(to);
  const ok = await resetPath(to);
  if (!ok || !RESEND_AFTER) return;
  const t = setTimeout(() => {
    log && log(`DM RECOVERY RESEND ${hex6(to)} after path reset`);
    sendRecoveryDm(text, to);
  }, RECOVERY_GAP_MS);
  t.unref && t.unref();
};

// sendDm terminal onMiss (replaces null):
attempt < DM_RETRIES
  ? () => { setTimeout(() => sendDm(text, to, attempt + 1), RETRY_GAP_MS); }
  : () => { handleTerminalMiss(text, to); }
```
**Unchanged:** `clamp`, `MAX_TEXT`, `note`, `trackDelivery` body, `sendChannelText`, `getSelfTelemetry`, public API.

### 6.2 `index.js`
Opts wiring beside `dmRetries` (index.js:566): `resetPathOnFailure`, `resendAfterPathReset`, `resetRecoveryGapSeconds`, `resetPathCooldownMinutes` from `settings.communications`.
Schema (grouped with `dm_retries`, index.js:948) — exact architect fields:
```
reset_path_on_failure       boolean default true
resend_after_path_reset     boolean default true
reset_recovery_gap_seconds  number  default 3  min 0
reset_path_cooldown_minutes number  default 10 min 0
```

---

## 7. Logging
```
NO DELIVERY CONFIRMATION dm retry <n> (waited <s>s)
PATH RESET <prefix> after <n> failed attempts
PATH RESET FAILED <prefix>: <reason>
PATH RESET SUPPRESSED <prefix> — cooldown active
DM RECOVERY RESEND <prefix> after path reset
DELIVERED dm recovery (round trip <ms>ms)
NO DELIVERY CONFIRMATION dm recovery (waited <s>s)
```
Queue labels (distinct): `sendText`, `resetPath`, `sendTextRecovery`. Recovery miss logged only.

---

## 8. Edge cases (architect list — all covered)
Reset fails → FAILED log, no crash/wedge (15s queue timeout), no recovery resend · No `expectedAckCrc` → nothing · Offline first miss → reset+resend once · Offline repeat → cooldown suppress · Multiple alerts to offline → alert damper + reset cooldown both apply · Channel send → no reset/track/resend · Reconnect mid-op → logged, no unhandled rejection.

---

## 9. Test plan (`test/device.test.js`) — 15 cases
1 reset once on terminal miss · 2 one recovery send when enabled · 3 recovery no recursion · 4 no reset with retries remaining · 5 successful retry cancels reset · 6 disabled = legacy behavior · 7 resend-off = reset only · 8 reset failure logged+swallowed · 9 reset failure → no recovery resend · 10 cooldown suppresses repeat · 11 cooldown per-contact (B unaffected by A) · 12 channel send never resets · 13 missing `expectedAckCrc` never resets · 14 reset + recovery both via `queue.run` · 15 queue labels distinct.
Inject `nowMs` + fake timers for determinism. Target: 41 → 56 green; `npx eslint .` clean.

---

## 10. Acceptance criteria (architect's, mapped)
Triggers only on terminal directed-DM miss ✓ · reset queued ✓ · recovery optional/default-on ✓ · single-shot ✓ · short configurable delay ✓ · no recursion ✓ · per-contact cooldown ✓ · channels excluded ✓ · telemetry polling unchanged ✓ · alerts benefit only as directed DMs ✓ · reset API resolved ✓ · tests cover reset/resend/suppression/failure/queue/channel ✓.

**Final behavior statement:** *When a directed DM exhausts delivery-confirmation retries, the plugin resets the stored route for that contact, subject to a per-contact cooldown. After a successful reset it optionally sends one recovery copy of the failed DM after a short configurable delay; that recovery send is tracked for logging only and never schedules another retry, reset, or recovery resend. Channel sends and telemetry push are unaffected.*

---

## 11. Effort `[ESTIMATE]`
device.js ~40 lines · index.js wiring/schema ~20 · 15 tests ~3–4 hrs. **~0.75–1 day.** No hardware to land + unit-test; on-boat verification folds into Phase 5.

## 12. Remaining open `[OPEN]`
Installed meshcore.js version string (low priority — confirm on Cerbo). No behavioral blockers remain.
