# Design Review: `design-reset-path-on-miss-v2.1.md` (Review #3)

## Verdict

**[APPROVED — no further design review required.] Ship it after the one runtime check.**

This is the third senior review of the same design. v2.1 has converged. There are no architectural objections, no unresolved conflicts with the codebase, and no remaining required edits. Further review rounds add latency, not safety.

## Why this is the last review

The design has been reviewed three times against the live repo (`main`):

- **Review #1** (`...-v2-review.md`) — required 4 fixes (detached-resend catch, full-key cooldown, runtime-only cooldown wording, queue-timeout precision). **All adopted in v2.1.**
- **Review #2** (the v2.1 addendum) — required config-structure correction, line-number removal, timeout rewording, nowMs/test-baseline honesty, API-verification gate. **All adopted in v2.1.**
- **Review #3** (this doc) — required only the Option B listener-cleanup tightening. **Adopted in v2.1 §3.1.**

Each round produced strictly smaller findings: 4 fixes → 5 wording fixes → 1 cleanup nit. That is convergence. The next round would find nothing actionable, because the only open item is not a document problem — it is a runtime fact (`§3.1`) that no amount of prose can resolve.

## Verified-correct (re-confirmed against repo `main`)

- DM send still uses `queue.run(..., 'sendText')`, tracks `expectedAckCrc`, retries via `onMiss`, stops on terminal miss. v2.1 targets exactly that seam. ✓
- Queue-only radio access is mandatory; v2.1 honors it for `resetPath` and the recovery send. ✓
- `CommandQueue` 15000ms is an instance default (constructed with `undefined` timeoutMs), not a per-call property of `queue.run`. v2.1's wording is precise. ✓
- Config groups are top-level siblings (`dms`, `alerts`, …) flattened into `settings.communications` at runtime; new fields go in `dms`. v2.1 §6.2 is correct. ✓
- Recovery resend is single-shot, delayed, caught (`.catch`), and non-recursive (`onMiss=null`). ✓
- Cooldown is full-key internally, 6-byte prefix in logs, runtime-only with stated rationale. ✓
- Option B (§3.1) now cleans up `Ok`/`Err` listeners on success, error, and send-command rejection. ✓

## The only open item (not a design issue)

The high-level `connection.resetPath(pubKey)` wrapper cannot be proven from the repo (`node_modules` not committed). This is a **runtime check**, not a review finding:

```
node -e "const{Connection}=require('@liamcottle/meshcore.js');console.log(typeof Connection.prototype.resetPath, typeof Connection.prototype.sendCommandResetPath)"
```

- `function function` → Option A (call `resetPath` through `queue.run`).
- otherwise → Option B (local wrapper with listener cleanup, already specified in §3.1).

## Final approval statement

```
Architecture: APPROVED (3 reviews, converged).
Design text:  COMPLETE — no further edits required.
Blocking gate: run the Cerbo resetPath check (§3.1). This is the ONLY thing left.
Next step:    implement against v2.1 — device.js, dms schema fields, device.test.js (§9 cases).
No v2.3, no review #4. If something breaks, it will surface in tests or on-boat (Phase 5), not in another doc pass.
```

**Net:** v2.1 is the final, approved implementation reference. Stop reviewing. Run the check. Write the code.
