# Design Review: `design-reset-path-on-miss-v2.md`

## Verdict

[PROPOSED] **Approve with minor required edits before implementation.**

v2 correctly incorporates the major design-review feedback: single-shot recovery resend, non-zero recovery delay, per-contact cooldown, queue-only radio access, DM-only scope, no channel telemetry impact, and explicit reset API resolution.

[VERIFIED] The current `device.js` is still the correct implementation point: directed sends already go through `queue.run(..., 'sendText')`, delivery confirmation is tracked by `expectedAckCrc`, `onMiss` is the existing retry seam, and terminal miss currently stops after retries.

[VERIFIED] Queue serialization remains mandatory. `queue.js` explicitly says all radio commands go through one FIFO queue because concurrent meshcore.js command responses can cross-talk and hang.

## Required fixes before coding

### 1. Add `.catch(...)` to the detached recovery resend

v2 has this pattern:

```js
const t = setTimeout(() => {
  log && log(`DM RECOVERY RESEND ${hex6(to)} after path reset`);
  sendRecoveryDm(text, to);
}, RECOVERY_GAP_MS);
```

[VERIFIED] That conflicts with v2’s own non-goal: “no crash / unhandled rejection from reset failure.” If `sendRecoveryDm(...)` rejects because the queue times out, the connection drops, or `sendTextMessage` throws, this detached timer can create an unhandled rejection.

[PROPOSED] Change it to:

```js
const t = setTimeout(() => {
  log && log(`DM RECOVERY RESEND ${hex6(to)} after path reset`);
  sendRecoveryDm(text, to).catch((e) => {
    log && log(`DM RECOVERY RESEND FAILED ${hex6(to)}: ${e && e.message ? e.message : e}`);
  });
}, RECOVERY_GAP_MS);
```

Also add this as test case 16:

```text
16 recovery resend queue/send failure is logged and swallowed; no unhandled rejection
```

### 2. Use full public key for cooldown state, prefix only for logs

v2 uses:

```js
const hex6 = (to) => Buffer.from(to).slice(0, 6).toString('hex');
const resetAttempts = new Map(); // hex6(to) -> last ms
```

[PROPOSED] Do not key internal cooldown state by only the 6-byte prefix. The protocol may send only the prefix on the wire, but the plugin has the full public key. Use full hex for the map key and 6-byte prefix only for human-readable logs.

Recommended:

```js
const keyHex = (to) => Buffer.from(to).toString('hex');
const keyPrefix = (to) => Buffer.from(to).slice(0, 6).toString('hex');

const resetAttempts = new Map(); // full public key hex -> last ms
```

Then:

```js
const shouldSuppressReset = (to) => {
  const last = resetAttempts.get(keyHex(to));
  return last !== undefined && COOLDOWN_MS > 0 && (nowMs() - last) < COOLDOWN_MS;
};

const markResetAttempt = (to) => resetAttempts.set(keyHex(to), nowMs());
```

This avoids a low-probability but unnecessary prefix-collision bug.

### 3. Clarify that cooldown is runtime-only unless intentionally persisted

v2 correctly adds cooldown, but unlike the existing alert damper, it does not persist across plugin restarts. The existing alert damper writes history to disk because alert storms were observed in the field.

[PROPOSED] Runtime-only cooldown is acceptable for v1, but the design should say so explicitly:

```text
Reset-path cooldown is in-memory only for v1. A plugin restart clears it. This is acceptable because reset attempts are low-cost and the alert storm damper remains the primary persistent protection against repeated alert notifications.
```

Or, if stricter storm control is desired, persist it like `alertHistory`. Recommendation: keep it in-memory for v1.

### 4. Do not overstate what `queue.run` does for `resetPath`

v2 says `resetPath` has no internal timeout, so `queue.run` bounds it. That is operationally true for the plugin call, but it may not cancel any listeners that the underlying `meshcore.js` wrapper registered before timeout.

[PROPOSED] Slightly reword:

```text
resetPath has no internal timeout. The plugin call must therefore be wrapped in queue.run so the plugin does not wait indefinitely. This bounds plugin behavior, although the underlying meshcore.js promise may still settle later if the radio eventually emits Ok/Err.
```

This is more precise and avoids implying cancellation semantics that `queue.run` does not provide. The queue rejects timed-out commands and keeps the chain alive; it does not cancel the underlying library promise.

## Things v2 now gets right

[VERIFIED] **DM-only scope is correct.** `sendChannelText` uses a separate `sendChannelTextMessage(...)` path and does not call `trackDelivery`, so v2’s “channel sends unaffected” claim matches the current code.

[VERIFIED] **Recovery resend as single-shot is correct.** Using `trackDelivery(sent, 'dm recovery', null)` prevents recursion through the normal retry/reset path.

[VERIFIED] **Reset command through queue is correct.** `queue.run(() => connection.resetPath(to), 'resetPath')` follows the current queue contract.

[VERIFIED] **Alert interaction is correctly scoped.** Alerts benefit only because `handleNotification(...)` sends directed messages to crew via `device.sendText(...)`; channel alert posts remain separate.

[VERIFIED] **Crew telemetry polling is unaffected.** Crew polling uses `connection.getTelemetry(key)` through the queue, not the directed DM send path.

[VERIFIED] **Dependency API blocker is materially reduced.** Upstream `connection.js` contains `sendCommandResetPath(pubKey)` and the current design says the installed source has a high-level `resetPath(pubKey)` wrapper that resolves on `Ok`/`Err`. The repo imports `@liamcottle/meshcore.js` dynamically, so implementation still needs a final local install check, but this is no longer a design blocker.

## Test plan additions

The 15 cases in v2 are good. Add these:

```text
16 recovery resend send failure is caught and logged
17 cooldown key uses full public key, not 6-byte prefix
18 reset_path_cooldown_minutes = 0 disables cooldown suppression
19 resetPath queue timeout is logged as PATH RESET FAILED and does not recovery resend
```

## Revised approval statement

[PROPOSED] v2 is architecturally approved after these edits:

```text
Required:
- catch detached recovery resend failures
- key cooldown by full public key
- clarify runtime-only cooldown
- clarify queue timeout does not cancel underlying meshcore.js listener/promise
- add tests for recovery resend failure and full-key cooldown behavior
```

The core design is now aligned with the current solution. The remaining issues are implementation safety and wording precision, not architectural conflicts.
