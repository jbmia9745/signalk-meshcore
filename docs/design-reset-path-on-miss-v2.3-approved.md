# Design v2.3 (APPROVED) — Auto Reset-Path on Directed DM Delivery Failure

**Status:** `[APPROVED FOR IMPLEMENTATION — johnrbek, 2026-06-20]`. Design is frozen. This is the authoritative implementation reference. Implementation may proceed once the §3.1 Cerbo `resetPath` API check is run. Do not revise the design further unless that check contradicts the reset API assumption.
**Scope:** `plugin/device.js` (primary), `plugin/index.js` (config wiring + schema), `test/device.test.js`.
**Lineage:** v1 = `docs/design-reset-path-on-miss.md` (no recovery resend, no cooldown). v2 = `docs/design-reset-path-on-miss-v2.md` (added recovery/cooldown). v2.1 = `docs/design-reset-path-on-miss-v2.1.md` (text corrections + Option B cleanup). This v2.3 is the frozen, approved snapshot of v2.1; it supersedes all prior versions.
**Verification note:** All code claims below were checked against the repo `main` branch this session. Line numbers are deliberately omitted — see §6 — because they were already stale in v2 and drift on every edit. Reference code by **symbol/block name**.

---

## 1. Problem statement `[VERIFIED]`

A contact's learned direct path goes stale when a repeater in it moves/decommissions; DMs then fail and **no layer of DDRM's stack heals the path**:
- Firmware: `MyMesh::onSendTimeout()` is empty; `resetPathTo` is never called on timeout (`reference/MeshCore/.../MyMesh.cpp`, `BaseChatMesh.cpp`). *(Firmware files live in the `reference/MeshCore` tree; re-confirm on the rig if the submodule isn't checked out.)*
- meshcore.js: a `resetPath` exists but is never auto-invoked; `sendTextMessage` sends once, no fallback.
- Plugin: today `sendDm`'s terminal `onMiss` is `null` — after `dm_retries` it simply stops (verified in `device.js`, `sendDm`).

Self-heal in faq.md Q5.3 is **app-layer only**. DDRM is headless → the heal must happen in-plugin.

**Observed:** Crew1 pinned through a decommissioned repeater → repeated delivery failures → manual ResetPath required (×3 this session, including a remote reset from home).

---

## 2. Goal / non-goals

**Goal:** On terminal directed-DM delivery failure, reset that contact's stored path (subject to a per-contact cooldown) so the next directed send floods and relearns; then optionally fire ONE recovery copy of the failed DM after a short delay.

**Non-goals (preserved):** no change to channel sends or telemetry push; no multi-path selection; no firmware route changes; no queue bypass; no recursive recovery; no recovery for sends without `expectedAckCrc`; no crash / unhandled rejection from reset *or recovery* failure. Alerts benefit only incidentally (they are directed DMs to crew).

---

## 3. Verified basis

| Fact | Source (symbol/block, read this session) |
|---|---|
| Directed sends go through `queue.run(..., 'sendText')` | `device.js` → `sendDm` |
| Delivery confirm = `SendConfirmed` matched by `expectedAckCrc` | `device.js` → `trackDelivery` |
| Terminal `onMiss` is currently `null` (stops after retries) — the seam we replace | `device.js` → `sendDm` terminal branch |
| Channel sends use `sendChannelTextMessage` and never call `trackDelivery` | `device.js` → `sendChannelText` |
| All radio commands serialize through the FIFO queue | `queue.js`; spec §11 |
| `queue.run(fn, label)` rejects on timeout using the **instance** `timeoutMs` (not a per-call value) | `queue.js` → `run` |
| Queue is constructed with `undefined` timeoutMs → falls back to the **15000ms default** | `index.js` → `CommandQueue` constructor; default in `queue.js` |
| Config groups are top-level siblings (`dms`, `alerts`, …) merged into `settings.communications` | `index.js` → `settings.communications` spread merge |
| Existing alert-storm damper persists to disk (`alert-history.json`) — precedent, but we deliberately differ (§6.1) | `index.js` → `alertHistory` load/save |

### 3.1 Reset API — VERIFY BEFORE CODING `[OPEN — must close]`

v2 asserted that the installed `@liamcottle/meshcore.js` (`^1.13.0`) exposes a high-level `connection.resetPath(pubKey)` that resolves on `Ok`/`Err`. **This cannot be confirmed from the repo** (`node_modules` is not committed). It is **load-bearing for the whole feature**, so treat it as a gate, not a footnote.

**Required check on the target runtime (Cerbo):**
```
node -e "const{Connection}=require('@liamcottle/meshcore.js');console.log(typeof Connection.prototype.resetPath, typeof Connection.prototype.sendCommandResetPath)"
```
- **`function function`** → use **Option A**: call `connection.resetPath(to)` directly (resolves on protocol `Ok`/`Err`).
- **`undefined function`** (no high-level wrapper) → use **Option B**: implement a local wrapper that calls `sendCommandResetPath(to)` and resolves on the next `ResponseCodes.Ok` / rejects on `ResponseCodes.Err`. **Option B MUST remove both listeners on all three exits — success, error, and a `sendCommandResetPath` rejection before either response arrives** — so the wrapper never leaves listener residue on `connection`:
  ```js
  const resetPathRaw = (to) => new Promise((resolve, reject) => {
    const cleanup = () => {
      connection.off(ResponseCodes.Ok, onOk);
      connection.off(ResponseCodes.Err, onErr);
    };
    const onOk  = ()  => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(new Error(`reset Err${e && e.errCode !== undefined ? ` ${e.errCode}` : ''}`)); };
    connection.once(ResponseCodes.Ok, onOk);
    connection.once(ResponseCodes.Err, onErr);
    connection.sendCommandResetPath(to).catch((e) => { cleanup(); reject(e); }); // send-command reject also cleans up
  });
  ```
  Either way the call is wrapped in `queue.run(...)`, which remains the outer time bound; never treat "frame written" as "reset accepted." *(Belt-and-suspenders: because Option B owns the wrapper, an internal cleanup timeout could also be added; not required while `queue.run` is the outer bound.)*

---

## 4. Use cases
- **UC-1 Self-heal:** all retries miss → cooldown clear → reset → wait gap → one recovery send → fresh path relearned.
- **UC-2 Transient loss:** retry within `dm_retries` delivers → no reset.
- **UC-3 Offline (first miss):** reset + recovery fire once → still fails → path stays unset, relearns on return.
- **UC-4 Offline (repeat in cooldown):** `PATH RESET SUPPRESSED`, no reset/resend.
- **UC-5 Disabled:** `reset_path_on_failure=false` → log miss only.
- **UC-6 Reset fails:** log `PATH RESET FAILED`, **no recovery resend**, no crash.
- **UC-7 Resend off:** reset only.
- **UC-8 No `expectedAckCrc`:** no track/reset/resend.
- **UC-9 Channel miss:** no reset logic engaged.
- **UC-10 Reconnect mid-op:** queue failure logged, no unhandled rejection.
- **UC-11 Recovery send itself fails:** caught + logged, no unhandled rejection.

---

## 5. Functional flow (terminal-miss handler)
```
trackDelivery timeout AND attempt >= dm_retries:
  1. log NO DELIVERY CONFIRMATION (terminal)
  2. if !reset_path_on_failure → stop
  3. if cooldown active for contact → log PATH RESET SUPPRESSED → stop
  4. markResetAttempt(contact)                 // cooldown timestamp (full-key)
  5. queue resetPath(contact)
       Ok  → log PATH RESET
       Err → log PATH RESET FAILED → stop      // no recovery resend on failed reset
  6. if !resend_after_path_reset → stop
  7. wait reset_recovery_gap_seconds
  8. queue ONE recovery send; trackDelivery(onMiss=null); .catch(log)  // single-shot, failure-safe
  9. recovery NEVER retries/resets/resends
```
Defaults: `reset_path_on_failure=true`, `resend_after_path_reset=true`, `reset_recovery_gap_seconds=3`, `reset_path_cooldown_minutes=10`.

---

## 6. Technical design

### 6.1 `device.js`
New seams added inside `makeDevice` (matching the existing `!== undefined` opts idiom already used for `DM_RETRIES`/`RETRY_GAP_MS`):

```js
// new opts in makeDevice, beside DM_RETRIES / RETRY_GAP_MS
const RESET_ON_FAIL   = !(opts && opts.resetPathOnFailure   === false); // default true
const RESEND_AFTER    = !(opts && opts.resendAfterPathReset === false); // default true
const RECOVERY_GAP_MS = 1000  * ((opts && opts.resetRecoveryGapSeconds  !== undefined) ? opts.resetRecoveryGapSeconds  : 3);
const COOLDOWN_MS     = 60000 * ((opts && opts.resetPathCooldownMinutes !== undefined) ? opts.resetPathCooldownMinutes : 10);

// resetAttempts is INTENTIONALLY in-memory, process-lifetime only (see §8).
const resetAttempts   = new Map();                       // FULL pubkey hex -> last ms
// nowMs is NEW test plumbing — current device.js does not inject it. Added here for
// deterministic cooldown tests; falls back to Date.now in production.
const nowMs = (opts && opts.nowMs) || (() => Date.now());

const keyHex    = (to) => Buffer.from(to).toString('hex');            // internal state key
const keyPrefix = (to) => Buffer.from(to).slice(0, 6).toString('hex'); // logs only

const shouldSuppressReset = (to) => {
  const last = resetAttempts.get(keyHex(to));
  return last !== undefined && COOLDOWN_MS > 0 && (nowMs() - last) < COOLDOWN_MS;
};
const markResetAttempt = (to) => resetAttempts.set(keyHex(to), nowMs());

const resetPath = (to) => queue.run(() => connection.resetPath(to), 'resetPath').then(
  () => { log && log(`PATH RESET ${keyPrefix(to)} after ${DM_RETRIES + 1} failed attempts`); return true; },
  (e) => { log && log(`PATH RESET FAILED ${keyPrefix(to)}: ${e && e.message ? e.message : e}`); return false; },
);

const sendRecoveryDm = (text, to) => {
  note('dm recovery', text);
  return queue.run(
    () => connection.sendTextMessage(to, clamp(text), Constants.TxtTypes.Plain),
    'sendTextRecovery',
  ).then((sent) => trackDelivery(sent, 'dm recovery', null)); // onMiss=null → single-shot
};

const handleTerminalMiss = (text, to) => {
  if (!RESET_ON_FAIL) return;
  if (shouldSuppressReset(to)) { log && log(`PATH RESET SUPPRESSED ${keyPrefix(to)} — cooldown active`); return; }
  markResetAttempt(to);
  resetPath(to).then((ok) => {
    if (!ok || !RESEND_AFTER) return;
    const t = setTimeout(() => {
      log && log(`DM RECOVERY RESEND ${keyPrefix(to)} after path reset`);
      // REQUIRED: catch the detached resend so a queue timeout / send throw
      // cannot become an unhandled rejection (non-goal §2).
      sendRecoveryDm(text, to).catch((e) => {
        log && log(`DM RECOVERY RESEND FAILED ${keyPrefix(to)}: ${e && e.message ? e.message : e}`);
      });
    }, RECOVERY_GAP_MS);
    t.unref && t.unref();
  });
};
```

Terminal `onMiss` seam in `sendDm` — replace the current `null`:
```js
attempt < DM_RETRIES
  ? () => { setTimeout(() => sendDm(text, to, attempt + 1), RETRY_GAP_MS); }
  : () => { handleTerminalMiss(text, to); }
```
**Unchanged:** `clamp`, `MAX_TEXT`, `note`, `trackDelivery` body, `sendChannelText`, `getSelfTelemetry`, public API.

### 6.2 `index.js` — config placement (corrected)

There is **no `communications` schema group**. The schema's top-level `properties` are sibling groups: `device`, `nodes`, `telemetry_features`, `alerts`, **`dms`**, `telemetry`, `switches`. At runtime `index.js` merges several of these into a single object (`settings.communications = { ...settings.communications, ...settings.telemetry_features, ...settings.alerts, ...settings.dms }`) and reads normalized values off `settings.communications`.

**Therefore:**
- **Schema:** add the four new fields **inside the existing `dms` schema object** (alongside `dm_retries`, `dm_retry_gap_seconds`). They reach the runtime via the existing `...settings.dms` spread — no new merge needed.
  ```
  reset_path_on_failure       boolean default true
  resend_after_path_reset     boolean default true
  reset_recovery_gap_seconds  integer default 3   min 0
  reset_path_cooldown_minutes integer default 10  min 0
  ```
- **Wiring:** in the `makeDevice(...)` options object (the same block that maps `dm_retries → dmRetries`), add the snake→camel mappings, read from `settings.communications`:
  ```js
  resetPathOnFailure:      (settings.communications || {}).reset_path_on_failure,
  resendAfterPathReset:    (settings.communications || {}).resend_after_path_reset,
  resetRecoveryGapSeconds: (settings.communications || {}).reset_recovery_gap_seconds,
  resetPathCooldownMinutes:(settings.communications || {}).reset_path_cooldown_minutes,
  ```

---

## 7. Logging
```
NO DELIVERY CONFIRMATION dm retry <n> (waited <s>s)
PATH RESET <prefix> after <n> failed attempts
PATH RESET FAILED <prefix>: <reason>
PATH RESET SUPPRESSED <prefix> — cooldown active
DM RECOVERY RESEND <prefix> after path reset
DM RECOVERY RESEND FAILED <prefix>: <reason>
DELIVERED dm recovery (round trip <ms>ms)
NO DELIVERY CONFIRMATION dm recovery (waited <s>s)
```
Prefixes are the 6-byte hex; **internal cooldown state is keyed by the full pubkey hex**. Queue labels (distinct): `sendText`, `resetPath`, `sendTextRecovery`.

---

## 8. Edge cases & operational notes

- **Reset fails** → `PATH RESET FAILED`, no crash/wedge, no recovery resend. The reset call is bounded by the **configured `CommandQueue` timeout** — currently the **15000ms default**, because `index.js` constructs `CommandQueue` with `undefined` timeoutMs. **Important:** this bounds only *plugin* behavior. `queue.run` rejecting on timeout does **not** cancel any underlying meshcore.js promise or its `once(Ok/Err)` listeners — those may still settle later if the radio eventually responds.
- **Recovery send fails** (queue timeout / drop / throw) → caught and logged via `.catch` (§6.1); no unhandled rejection.
- **No `expectedAckCrc`** → `trackDelivery` no-op path; nothing fires.
- **Offline first miss** → reset + resend once; **offline repeat** → cooldown suppress.
- **Multiple alerts to offline contact** → the persistent alert damper *and* the reset cooldown both apply.
- **Channel send** → no reset/track/resend (separate `sendChannelTextMessage` path).
- **`resetAttempts` lifetime:** **intentionally in-memory, process-lifetime only** for v1. Unlike `alertHistory` (persisted to `alert-history.json` because field-observed alert storms warranted it), reset attempts are low-cost and the crew/contact set is tiny, so the map cannot grow meaningfully and a restart simply clears stale cooldowns. The persistent alert damper remains the primary storm-control mechanism. Revisit persistence only if reset storms are actually observed.

---

## 9. Test plan (`test/device.test.js`)

**Baseline:** do **not** assert a specific green count. The current `device.test.js` contains ~6 cases; any "41 → 56" style claim from v2 is unverified and removed. Before merge, run `node --test` and record the real before/after numbers. The design specifies the **required new cases**, not a total.

`nowMs` injection is **new plumbing** this design adds (current `device.js` has no `nowMs` seam). Tests inject `nowMs` for deterministic cooldown and use `node --test` fake timers (`t.mock.timers`) for `RECOVERY_GAP_MS`/`RETRY_GAP_MS`, matching the existing retry test's pattern. Confirm `t.unref` is a no-op (not a throw) under mocked timers.

Required cases:
1. reset once on terminal miss
2. one recovery send when enabled
3. recovery no recursion (onMiss=null)
4. no reset with retries remaining
5. successful retry cancels reset
6. disabled (`reset_path_on_failure=false`) = legacy stop-after-retries behavior
7. resend-off = reset only
8. reset failure logged + swallowed (no crash)
9. reset failure → no recovery resend
10. cooldown suppresses repeat for same contact
11. cooldown is per-contact (contact B unaffected by A) — **assert full-key keying**
12. channel send never resets/tracks
13. missing `expectedAckCrc` never resets
14. reset + recovery both go through `queue.run`
15. queue labels distinct (`sendText` / `resetPath` / `sendTextRecovery`)
16. **recovery resend send/queue failure is caught + logged; no unhandled rejection**
17. **cooldown key uses full public key, not 6-byte prefix** (two contacts sharing a 6-byte prefix do not collide)
18. **`reset_path_cooldown_minutes = 0` disables suppression**
19. **`resetPath` queue timeout → `PATH RESET FAILED` and no recovery resend**

`npx eslint .` clean.

---

## 10. Acceptance criteria
Triggers only on terminal directed-DM miss ✓ · reset queued ✓ · recovery optional/default-on ✓ · single-shot ✓ · short configurable delay ✓ · no recursion ✓ · detached resend failure caught ✓ · per-contact cooldown keyed by full pubkey ✓ · cooldown runtime-only (documented) ✓ · channels excluded ✓ · telemetry polling unchanged ✓ · alerts benefit only as directed DMs ✓ · reset API verified on target before coding ✓ · queue-timeout wording precise ✓ · tests cover reset/resend/suppression/failure/queue/channel/full-key/zero-cooldown ✓.

**Final behavior statement:** *When a directed DM exhausts delivery-confirmation retries, the plugin resets the stored route for that contact, subject to a per-contact (full-key) cooldown. After a successful reset it optionally sends one recovery copy of the failed DM after a short configurable delay; that recovery is tracked for logging only, catches its own failures, and never schedules another retry, reset, or recovery resend. Channel sends and telemetry push are unaffected.*

---

## 11. Effort `[ESTIMATE]`
device.js ~40 lines · index.js wiring + `dms` schema fields ~20 · ~9 new tests ~3–4 hrs. **~0.75–1 day.** On-boat verification folds into Phase 5.

## 12. Gate before implementation `[OPEN]`
1. **Run the `resetPath` API check on the Cerbo (§3.1).** `function function` → Option A (call through `queue.run`); otherwise Option B local wrapper **with listener cleanup on all three exits**. Do not write the feature until this is confirmed.
2. (Low priority) record the installed meshcore.js version string from the Cerbo.

**Sign-off (johnrbek, 2026-06-20):** APPROVED FOR IMPLEMENTATION. Architecture frozen. Implementation may proceed after the gate above. Constraints carried into code: recovery resend stays single-shot, delayed, caught, and non-recursive; cooldown stays full-keyed and runtime-only for v1; Option B (if used) cleans up `Ok`/`Err` listeners on success, error, and send-command rejection; add the §9 `node --test` coverage before merge. Do not revise the design further unless the §3.1 Cerbo check contradicts the reset API assumption.
