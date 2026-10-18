# Prepare reusable facts while composing

## Outcome and measured starting point

Pressing Send should get to the model sooner without paying for speculative
inference or holding a turn worker for someone who never sends.

An October 18, 2026 browser baseline on `a5a5500efc` used three new-chat/follow-up
pairs, the same Codex model and reasoning setting, ordinary tools, no sandbox,
and one-word replies. Each follow-up waited for the preceding turn to become
idle. Browser capture-phase click times were joined to accepted-turn, claim,
`turn.started`, provider-dispatch and first-byte timestamps.

| Measurement (milliseconds) | New chat | Existing chat |
| --- | ---: | ---: |
| Send → provider first byte, median | 3,160 | 3,073 |
| Send → visible reply, median | 4,475 | 4,208 |
| Send → acceptance, mean | 402 | 340 |
| Acceptance → claim, mean | 228 | 217 |
| Claim → turn.started, mean | 238 | 211 |
| turn.started → provider dispatch, mean | 1,625 | 1,345 |
| Provider dispatch → first byte, mean | 767 | 1,539 |

The existing-chat mean includes a 3,132 ms provider outlier. Provider first byte
is not necessarily the first visible text token. First byte → visible reply
includes reasoning and generation, not only frontend rendering.

During the same five-minute window, aggregate startup-phase means were 874 ms
for Codex credential selection versus 63 ms for Claude, 468/544 ms for
claim-and-policy, 185/128 ms for tools and 23/23 ms for request audit. These
mixed-traffic phase samples overlap and are not additive. The broad credential
phase is not all catalog work; the live comparison must establish the actual
gain rather than assuming the entire difference disappears.

## Decision

Use the existing debounced durable draft saves as the preparation hint, and the
existing shared subscription catalog as the reusable result. Fix the underlying
cross-process freshness miss instead of introducing a speculative turn lifecycle.

1. A successful new-chat or existing-chat draft save schedules best-effort model
   preparation outside the save response. Empty drafts and disabled subscription
   deployments do nothing. Only a selected Codex subscription model causes a
   shared-account catalog refresh. Draft text is not sent to a provider.
   Preparation reads only an already-fresh credential through the normal scoped
   resolver. If its existing refresh policy says renewal is due, the hint skips
   that connection: typing must never rotate a token or mark an account unusable.
2. The core catalog reader already checks live workspace scope, source policy,
   allocator eligibility and credential generation. Expose its fresh observation
   with the original observation and expiry times. The model picker and real
   turn reuse it without decrypting a token or querying the provider again.
3. Missing, expired or generation-mismatched facts take the existing provider
   discovery path. Failed discovery remains unknown, not an entitlement denial.
   Personal connections still require an accepted-turn lease and are not probed.
   Normal model access retains proactive credential renewal; only the speculative
   hint uses the resolver's fresh-only read. This avoids an admission race where
   a failed speculative renewal could turn a zero-credit subscription draft into
   a refusal before its real Send.
4. On the accepted path, overlap learning-policy freezing with attachment-authority
   reading. Both finish before installing the same file-access context. This does
   not move model-input projection or reorder durable conversation writes.

### Timing and abandoned work

The existing composers save after 500 ms of inactivity. Keep that debounce: it
already avoids per-keystroke requests and gives a short provider metadata read
time to finish before Send. Keep the existing catalog lifetime of 60 seconds;
it is not a new entitlement staleness allowance. Reads never extend that expiry.

Each API process coalesces preparation hints for one actor/workspace/model while
the refresh is pending or its actual observation remains fresh (five seconds
after a failure). A later edit can refresh an expired fact; no full fresh minute
is assumed for an observation that was already almost expired. No periodic job, idle renewal, workflow, worker permit, model
request, prompt-cache warming, MCP connection or sandbox lease is created.
The ordinary bounded provider metadata operation handles a miss. If typing stops,
no more work is scheduled; catalog facts age out and later hints prune expired entries.
Replicas can race on a cold miss, as existing model-picker reads can, but subsequent
reads share the database fact. No new infrastructure resource cap is introduced.

### Edits, control changes and SDKs

- Draft text edits do not invalidate account model support. Model switches are
  separate hints; Send always selects its model and freezes policy at admission.
- Tabs share stored facts, never draft text, authority, credentials or turn state.
- Pause/busy changes are safe: preparation cannot resume a session or claim work.
  An accepted turn still takes the normal exact authority and placement path.
- Revoked scope, disabled sources, disconnected accounts and rotated credentials
  are checked by live readers and placement, not a speculative authority snapshot.
- Web and React/React Native durable existing-chat composers already use these
  command paths. The native new-chat draft endpoint benefits too. No client or
  API contract changes are needed.
- Embedders that deliberately disable durable draft persistence, and host-owned
  new-chat composers that only call their create callback at Send, do not emit a
  preparation hint. They still benefit from fresh facts written by any picker or
  turn. Do not run a host's create/before-send hooks during typing or silently
  persist text that the host chose to keep local.

## Alternatives not chosen

A waiting `runAgentTurn` would retain a Temporal activity and worker permit for
each typer. Pre-acceptance credentials and tools would also need invalidation,
affinity and a second authority boundary. Reserving identities for nonexistent
new chats would change atomic creation and admission just to prepare facts that
are workspace/account scoped already. Neither is justified by these measurements.

Persistent model transport is already opened during ordinary preparation; a warm
connection was measured separately at about 9 ms. This change does not duplicate
that work or send speculative model requests.

## Sandbox finding

Managed compute is normally on demand in `sandbox-route.ts`; ordinary tool-only
turns do not provision it just because a person types. Existing exceptions include
repository/recovery preparation and files or workspace Skills that genuinely need
filesystem access before the model. Machine-primary and explicitly eager routes
also keep their existing behavior. This change invokes none of those routes and
does not claim that every existing turn is universally lazy.

## Verification

Tests cover persisted hits without bearer access or provider requests, empty and
unknown catalogs, original expiry, future observations, live scope removal,
credential rotation, disabled allocator eligibility, personal-account isolation,
coalesced edits, discarded drafts and hints after expiry. Database tests run with
the application role and real PostgreSQL. Repeat the same browser pairs after
deployment, recording the exact release and separating startup from provider
latency; do not count a provider-generation fluctuation as startup improvement.
