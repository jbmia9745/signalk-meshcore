# Final Review: `design-reset-path-on-miss-v2.1.md`

## Verdict

[PROPOSED] **Approve v2.1 as the implementation reference, with one small but important addition to the Option B reset wrapper.**

v2.1 absorbed the prior review correctly. It fixes the config-structure description, removes stale line-number dependency, clarifies queue timeout semantics, keeps recovery resend single-shot, catches detached recovery-send failure, keys cooldown by full public key, documents runtime-only cooldown, and makes reset API verification an implementation gate.

## What v2.1 gets right

[VERIFIED] The current repo still has the v1 behavior: directed DM send uses `queue.run(..., 'sendText')`, tracks `expectedAckCrc`, retries through `onMiss`, and then stops on terminal miss. That is exactly the seam v2.1 targets.

[VERIFIED] Queue-only radio access is correctly treated as mandatory. `queue.js` says all radio commands go through one FIFO queue because concurrent meshcore.js command responses can cross-talk and hang.

[VERIFIED] The timeout wording is now correct. `CommandQueue` defaults to `15000ms`, but that is an instance default, not a hard-coded per-call property of `queue.run`.

[VERIFIED] The config correction is right. The repo schema has top-level groups including `dms`, and `dm_retries` / `dm_retry_gap_seconds` live inside `dms`; runtime wiring then reads normalized values from `settings.communications`.

[VERIFIED] The alert-damper comparison is valid. Alerts already have persistent storm damping via `alertHistory`, and v2.1 correctly explains why reset cooldown can remain in-memory for v1.

[VERIFIED] The reset API gate is still necessary. Upstream `meshcore.js` source verifies `sendCommandResetPath(pubKey)`, but does not prove that the installed `@liamcottle/meshcore.js` package exposes a high-level `resetPath(pubKey)` wrapper. The project dynamically imports `@liamcottle/meshcore.js`, so the target runtime check remains load-bearing.

## One required addition before final handoff

### Tighten the Option B wrapper cleanup

v2.1’s Option B sketch is directionally right, but it should clean up listeners if `sendCommandResetPath(to)` rejects before `Ok`/`Err`.

Current sketch:

```js
const resetPathRaw = (to) => new Promise((resolve, reject) => {
  const onOk  = () => { connection.off(ResponseCodes.Err, onErr); resolve(); };
  const onErr = () => { connection.off(ResponseCodes.Ok, onOk);  reject(new Error('reset Err')); };
  connection.once(ResponseCodes.Ok, onOk);
  connection.once(ResponseCodes.Err, onErr);
  connection.sendCommandResetPath(to).catch(reject);
});
```

Recommended replacement:

```js
const resetPathRaw = (to) => new Promise((resolve, reject) => {
  const cleanup = () => {
    connection.off(ResponseCodes.Ok, onOk);
    connection.off(ResponseCodes.Err, onErr);
  };

  const onOk = () => {
    cleanup();
    resolve();
  };

  const onErr = (e) => {
    cleanup();
    reject(new Error(`reset Err${e && e.errCode !== undefined ? ` ${e.errCode}` : ''}`));
  };

  connection.once(ResponseCodes.Ok, onOk);
  connection.once(ResponseCodes.Err, onErr);

  connection.sendCommandResetPath(to).catch((e) => {
    cleanup();
    reject(e);
  });
});
```

[PROPOSED] Add this as an explicit requirement under §3.1: **Option B must clean up `Ok`/`Err` listeners on success, error, and send-command rejection.**

This does not change the architecture. It just prevents a local wrapper from creating avoidable listener residue.

## Non-blocking note

v2.1 already says queue timeout does not cancel the underlying meshcore.js promise/listeners. That is accurate. For Option B, because the plugin controls the wrapper, the developer may also add an internal cleanup timeout if belt-and-suspenders protection is desired. Not required if `queue.run` remains the outer bound, but worth considering.

## Final approval statement

[PROPOSED] Final approval after adding the Option B cleanup note:

```text
Architecture approved.
Implementation may proceed after the Cerbo resetPath API check is run.
If resetPath exists, use it through queue.run.
If only sendCommandResetPath exists, implement the local Ok/Err wrapper with listener cleanup.
Keep recovery resend single-shot, delayed, caught, and non-recursive.
Keep cooldown full-keyed and runtime-only for v1.
Add the specified node:test coverage before merge.
```

Net: **v2.1 is ready, pending the reset API check and the small Option B cleanup edit.**
