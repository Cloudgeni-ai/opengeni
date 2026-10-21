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

## Follow-up: remove repeated catalog verification

A matched two-second composing cohort showed why catalog freshness alone is
not an instant-Send solution. Mean time from `turn.started` to credential
selection fell from 355 to 126 ms in new chats and 302 to 164 ms in follow-ups,
but acceptance to the request-start audit stayed almost flat: 1,757 to 1,751 ms
and 1,535 to 1,520 ms. Later tool/runtime work absorbed the saving. These are
three samples per case, not a stable tail-latency estimate. The request-start
audit precedes completion of the audit write and is not the socket-write time.

The six draft saves completed before Send. Retained events and scoped provider
request reservations cannot attribute a particular shared catalog observation
to its draft hint: the hint has no per-run trace, and catalog observations are
overwritten. Do not claim retrospective proof of that attribution. No new shared
credential-request reservation was recorded during those six measured turns;
this is consistent with reuse, not proof of which hint supplied the observation.

A separate local stack with real API, Temporal, PostgreSQL and MCP, and a
synthetic Responses endpoint, isolates application startup from provider
inference. Its warm twenty-turn baseline spent about 97 ms building the attempt
catalog, 90 ms persisting it and 28 ms constructing the agent. CPU sampling
identified repeated catalog parsing and canonical serialization, including a
full integrity check just to determine whether artifact tools are available.
The proposed overlap of tool connection with agent-input reads was not chosen:
those reads and their following catalog-history write measured only 13 ms here.

The ordinary catalog factory now returns a detached, deeply frozen snapshot.
After full schema, size and digest verification, its exact object identity can
reuse that verification within the process. A private WeakMap retains neither
another turn's authority nor a catalog beyond its consumers' lifetime. Caller
schemas remain mutable; mutations cannot alter the detached snapshot. Mutable
non-JSON objects are not registered as immutable snapshots.

Only factory-created snapshots qualify. A matching digest, a frozen look-alike,
a JSON copy or a database read still receives full verification. Database
read-back and blob-integrity checks stay unchanged, including the conflict and
replay paths. The same catalog bytes, tool order, prompt content and live
execution checks remain in place. No worker lifecycle, speculative tool
connection, model call, resource control or new API is introduced.

### Keep deferred setup off the first-request path

The production and minimal local fixtures do not have the same critical path.
Production defers an MCP carrier, so catalog construction and persistence are
reported as background phases. The minimal local fixture has no deferred
carrier and builds its catalog inline. A local catalog-only improvement must
not be presented as proof of a production startup improvement.

Temporal histories for the six production turns put activity queue waits at
4–10 ms. The exact chronological means below reconcile acceptance to the
request-start event; rounding accounts for a millisecond of difference.

| Interval (milliseconds) | New chat | Existing chat |
| --- | ---: | ---: |
| Acceptance → workflow start | 92 | 137 |
| Workflow start → turn activity start | 79 | 66 |
| Activity start → turn.started | 317 | 320 |
| turn.started → credential selection | 126 | 164 |
| Credential selection → tools started | 322 | 220 |
| Tools started → tools completed | 370 | 172 |
| Tools completed → model preparation | 261 | 333 |
| Model preparation → request started | 185 | 108 |
| Total | 1,751 | 1,520 |

These event intervals are not pure SQL or CPU measurements. There is no retained
per-turn pool-acquisition trace for this cohort. Low average worker CPU and
mostly idle database connections do not rule out short event-loop or transaction
waits. A later read-only database round-trip probe is not retrospective proof.

In the same production window, Codex background catalog build/persist means
were 278/191 ms; other provider traffic had longer builds. The exact measured
catalogs contained 178–179 entries, about 748 KB, comparable to the local
fixture's 171–172 entries and 744 KB. Background preparation runs on the same
JavaScript event loop. Its canonical serialization, validation and hashing can
therefore delay foreground continuations without the first request explicitly
awaiting its promise. Aggregate phases overlap and must not be added to the
chronological table above.

The end-state change keeps one preparation operation and one completion fence.
The worker starts non-eager preparation at the first main provider dispatch,
or on earlier real tool demand. Required eager tools still complete before the
request. The existing native and generic wire-dispatch hooks start the same
idempotent operation. A provider-neutral fallback starts it on a substantive
stream event or non-stream response, not a possibly synthetic `response_started`
marker. Recovery of journaled operations starts it before joining readiness.
No alternate workflow, speculative turn or authority
snapshot is created. Existing embedded callers retain immediate background
preparation unless they explicitly choose the dispatch-owned lifecycle.

This is not demand-only setup: starting at dispatch retains overlap with
provider latency, so the first tool call normally finds its catalog ready.
If the turn closes before dispatch or tool demand, cleanup closes the already
constructed servers without starting unused connections or catalog work.
Started preparation is joined and cleaned up through the existing ownership
path. A preparation failure still crosses the same lazy-tool fence.

Tests compare the first request's input, instructions and tool definitions with
preparation completed versus still pending for generic, OpenAI-native and
Codex-native disclosure. They also cover early tool demand, single start,
close-before-start, close during preparation, providers without dispatch hooks,
journal recovery and connection failure. Even with byte-identical request
fixtures, changing availability timing requires review as an agent-behavior
change; this must remain a draft until approved.

The expected saving is the CPU and database interference removed from before
dispatch, not the full production second. Claim, policy, credential authority,
eager tools and history remain on the accepted path. An instantaneous provider
can expose some deferred work while its response is being handled; measure
first byte as well as dispatch, and use a fixed provider-delay control before
claiming useful overlap. Production verification is still required.

### Matched development-stack result

The final control and candidate each used ten new-chat/follow-up pairs after a
separate warm-up pair. Both used real API admission, Temporal, PostgreSQL and
MCP, an approximately 744 KB catalog, and a synthetic Responses provider that
waited 700 ms before sending headers. The control disabled both immutable
verification reuse and dispatch-owned preparation. The candidate retained both.
No benchmark ran alongside the test suite. Times are milliseconds; p90 is the
nearest-rank sample percentile, not a production service-level estimate.

| Acceptance → milestone | Chat | Control median / p90 | Candidate median / p90 |
| --- | --- | ---: | ---: |
| Request-start event | New | 643 / 919 | 485 / 724 |
| Request-start event | Existing | 736 / 1,112 | 424 / 559 |
| Provider first byte | New | 1,362 / 1,640 | 1,211 / 1,447 |
| Provider first byte | Existing | 1,461 / 1,829 | 1,138 / 1,398 |

Mean request-start time fell from 735/899 to 522/489 ms (new/existing), and
first-byte time from 1,454/1,619 to 1,244/1,226 ms. Background catalog builds
started a mean 305/376 ms before request-start in the control and 16/14 ms after
it in the candidate. This directly verifies the intended scheduling change.

A separate warm zero-delay experiment isolated the two changes: control means
were 746/771 ms, immutable verification alone 499/507 ms, and both 422/393 ms.
The extra dispatch improvement was only partly reflected in first-byte latency
when the provider replied instantaneously. Delaying setup does not eliminate its
CPU cost; the immutable snapshot removes duplicate work, and dispatch ownership
moves the remainder into useful provider-wait time when available.

These fixtures use a direct provider and a small MCP fixture, not the production
subscription authority path. A plausible production target is roughly 150–400 ms
less startup interference, based on the local medians/means and retained catalog
phase durations. This is a hypothesis for matched canary pairs, not a promised
one-second saving or proof that all remaining latency is catalog CPU. The exact
production pool/transaction contribution remains unmeasured. Keep the PR draft
until the tool-timing change is reviewed, then compare new and existing chats,
first byte, and first tool readiness on the same canary.

## Follow-up: batch execution provider settings

A later production cohort separated explicit Steer from queued messages. The
three active Steer handovers took 144–194 ms, while the five explicit Steers
reached request-start in a median 1,756 ms. Thirty-two immediate existing-chat
Sends had a median of 1,873 ms; fourteen agent-created first turns had a median
of 1,833 ms. These are not human new-chat measurements. One existing-chat
sample included 38 seconds of compaction and remains in the raw cohort.

Six exact Temporal histories showed 4–8 ms activity queue waits and 11–24 ms
from activity start to the database transaction timestamp. For the three active
Steers, the claim reached its queued-to-running update after another 33–64 ms;
209–301 ms remained between that update and the durable `turn.started` event.
The latter includes the rest of the claim and post-claim reads, not only SQL.
Aggregate claim histograms mix turn sources and cannot be subtracted from these
exact intervals to infer pool wait. Current connection counts, fresh round-trip
probes and coarse event-loop maxima do not retrospectively attribute that wait.

One unnecessary accepted-path cost is directly observable in source and local
database traces: rebuilding provider settings opens 16–18 serial scoped
transactions even when no customer provider connections are active. Four reads
list the same workspace connections. Each transaction repeats admission,
scope setup and commit. The worker also duplicates the API's overlay sequence.

Read those inputs once in a fresh tenant-scoped transaction, then feed the same
overlay functions in the same order. Keep the full catalog: compaction, title,
auxiliary calls and model validation can need providers other than the selected
one. Preserve the bounded workspace-model queries, connection tie-breaks and
unchanged per-kind organization-model queries. Decrypt organization keys at
their original overlay points. Workspace credential resolution, direct-model
identity checks and selected-model access checks still run live through their
existing readers. Retired selections still use their existing execution reads.
The worker now calls the same aggregate function as stateless model calls.

There is no cross-execution cache, speculative credential read, new dispatch
path, policy bypass, worker hold or resource-control change. Prepared inputs
record their subscription/key-presence flags, so incompatible derived settings
fail instead of silently omitting a provider. Multiple invalid configurations
can now fail in read order rather than the former interleaved read/decrypt
order; the existing limit and credential errors remain fail-closed.

### Verification and limits

Real-PostgreSQL tests compare the entire settings object, including catalog JSON
order and synthetic credentials, against the serial path. They cover all five
provider families, mixed catalogs, retained retired models, disabled subscription
support, missing encryption keys, direct OpenAI/Azure models, connection
tie-breaks, revocation after the metadata read and tenant isolation. The empty
provider case falls from 18 scoped transactions to one. Active credentials and
selected-model checks legitimately add further transactions.

A local full-stack comparison used ten first-turn/Steer pairs per cohort, a
separate warm-up pair, a fixed 700 ms synthetic provider delay and no actual
sandbox tool use. Explicit worker reload markers verified the candidate and both
serial controls. An earlier run without verified reload is not a comparison.
Each cell below is median / nearest-rank p90, in milliseconds.

| Measurement | Serial control | Batch | Reverse serial control |
| --- | ---: | ---: | ---: |
| Provider settings, twenty observations | 11 / 16 | 4 / 5 | 14 / 24 |
| First acceptance → request-start | 420 / 466 | 342 / 415 | 661 / 855 |
| Steer acceptance → request-start | 486 / 589 | 435 / 471 | 707 / 817 |

Provider-settings means were 12 / 4 / 15 ms. The directly supported component
saving is therefore about 8–11 ms locally. Other phases moved substantially too,
so the larger whole-turn change is not attributed to batching. This is a small
structural improvement, not evidence that the production second has disappeared.
The new `claim_provider_settings` phase makes that slice separately measurable
after deployment. Production validation must also account for the earlier
deferred-preparation change; a lean local fixture and a production subscription
turn with real integrations are not matched controls.

## Follow-up: indexed inbox provenance lookups

Delivered updates still require the same live authority checks. Several of those
checks compare a turn's indexed UUID after converting the column to text. On a
large retained history this prevents a parameterized UUID index lookup, even
though the lineage names one exact turn. The same pattern occurs in the inbox
context and MCP binding fences and the subscription compatibility readers.

Convert the lineage value instead, inside a guarded CASE. Require exactly 36
bytes of canonical lowercase hexadecimal UUID text before casting; PostgreSQL's
ordinary UUID parser also accepts spellings the old text comparison rejected.
Keep `lower()` only at the compatibility sites that already normalized their
input. Malformed, missing and non-string lineage values remain nonmatches, not
cast errors. Workspace, session, source, credential and generation predicates
are unchanged. The migration patches exactly one occurrence of each of eight
known comparisons and fails on source drift. It adds no routine, grant, index,
lock, cached authority or runtime-posture exception, so old binaries can continue
using the same database functions during a rolling deployment.

Four bounded read-only production query comparisons over about 79,000 retained
workspace turns measured 52–63 ms for the original representative provenance
join versus 0.23–1.06 ms for the indexed form. The original plan touched roughly
25,730 shared buffers; the indexed form touched eight. These are lookup
measurements, not full trigger or turn measurements: other predicates can select
different plans or short-circuit the lookup. In particular, an empty-binding
local claim did not reproduce a stable whole-claim improvement in alternating
controls. Do not multiply the isolated lookup saving by the number of sites or
present it as the missing production second.

Real-PostgreSQL tests exercise every installed guard against canonical,
uppercase, malformed, missing and non-string JSON values; pin the existing
normalization differences; check wrong-workspace/session nonmatches; and verify
parameterized index scans with retained history. Existing receiver-context,
sender-binding and subscription-authority suites remain the behavioral gates.

## Follow-up: overlap accepted-turn catalog discovery

Expired shared-account catalogs still put a provider metadata request on the
accepted path. A mixed production interval measured a mean 442 ms for the
Codex entitlement phase. That is not a per-turn percentile or proof that every
turn queried the provider. Starting after all claim preparation would hide only
about 20 ms in that interval: learning freeze, identity read and health recovery
were already short. Start earlier, after the atomic claim has established the
exact attempt and its valid frozen Codex policy, alongside post-claim settings
and policy preparation.

The hint uses the same deployment settings and initiating human as the existing
reader, but only fresh credentials. It never renews a token or changes account
health before run admission. A renewal-due token skips preparation and remains
the responsibility of normal placement. Invalid or absent frozen policies,
compaction and deployments enabling cross-provider failover skip the hint; they
keep their existing capacity path rather than probing a possible fallback.

Placement joins the owned hint best-effort, then **always** runs the original
live entitlement check after health recovery. That reader checks current scope,
cutover, serving accounts, credential generation and expiry. A valid observation
avoids another provider request. A missing or renewal-deferred observation takes
the existing token/probe path. A failed early provider probe retains today's
five-second unknown-result cache; it is not persisted as an entitlement denial.
An early database error cannot replace an admission error or a later successful
live read. There is no new authority snapshot, TTL, model request or queue path.

The hint can use another existing pool connection while settings are read; no
pool configuration or resource control changes. Activity cleanup drains it on
every exit, including admission refusal, fencing and cancellation. The metadata
read retains its existing bounded timeout, so an early exit can still wait for
that in-flight read before final cleanup. No credential renewal is started by
the hint. Model input, tool disclosure and prompt-cache prefixes are unchanged.

### Claim attribution

Claim timing is not synonymous with SQL execution. Database admission includes
connection acquisition and BEGIN; nested admission includes SAVEPOINT. Scope
setup and callback timing can contain planning, locks and other reads, and nested
callbacks overlap their parents. Record bounded per-claim totals and counts for
those four stages, plus the continued-account and pending-update authority
callbacks. They are not additive critical-path intervals and carry no query,
session, account or credential identifiers as metric labels.

A local real-PostgreSQL child-result fixture invoked continued-account resolution
once and used nine nested scopes. Its ten measured claims had a median/p90 of
48/70 ms, of which the callback took 17/29 ms. This does not explain the mixed
production atomic-claim mean of 525 ms: production phase evidence, not that
source-reading hypothesis, must determine any further claim rewrite.

### Matched development-stack evidence

The full API/Temporal/PostgreSQL worker stack used a synthetic Codex account,
no tools or inference calls, and a fixed 442 ms `/models` response delay. Each
turn changed only the fixture's credential generation to force a cold catalog;
ordinary admission and placement still ran. Each traced cohort contained ten
new-chat/follow-up pairs after two separate warm-up pairs. Worker reload markers
confirmed the actual control/candidate path and were removed afterwards.

| Metric, milliseconds (median / p90) | Chat | Control | Candidate | Repeat candidate |
| --- | --- | ---: | ---: | ---: |
| Live entitlement wait | New | 455 / 459 | 395 / 400 | 399 / 405 |
| Live entitlement wait | Existing | 455 / 458 | 395 / 401 | 404 / 407 |
| Acceptance → request-start audit | New | 956 / 1,007 | 981 / 1,057 | 937 / 965 |
| Acceptance → request-start audit | Existing | 943 / 1,041 | 964 / 1,263 | 934 / 960 |

Candidate refresh work still took about 456–460 ms; overlapping it removed
roughly 50–60 ms from the local live wait, not the entire provider request.
The table presents control first for comparison; execution order was candidate,
control, repeat candidate. Total startup drifted enough that a stable end-to-end
improvement is not established. An earlier untraced run likewise showed no
reliable total-latency win. Production's longer post-claim window may hide more,
but that remains a canary hypothesis, not a measured saving. Warm catalog hits
still pay the live scope/serving read, and the hint adds an early read; track
both hit cost and cold-probe overlap before claiming a general improvement.

## Follow-up: prepare execution catalogs without compiling unused tools

The provider-dispatch preparation lifecycle previously applied only when at
least one MCP connection was deferred. When all servers were already required
or eager, it synchronously built and persisted the full execution catalog before
returning. Connection readiness and execution-catalog readiness are different:
the first request needs the connected servers' frozen visible schemas, not the
complete catalog used by later tool execution.

Use the existing lifecycle for explicit `provider-dispatch` preparation even
when there are no pending connections. Required and eager connections still
finish before disclosure, failures there still fail before inference, and their
schemas are frozen before returning. The catalog starts at provider dispatch
or earlier actual demand, once. Tool execution and cleanup join the same ready
promise. No extra provider request, speculative work, authority cache or sandbox
setup is introduced. Blocking approval/recovery preparation and embedded callers
that did not opt into provider-dispatch timing keep their previous behavior.

A configured agent must distinguish an unknown server catalog from a known,
empty catalog whose persistence is pending. Only genuinely deferred servers can
justify exposing the conditional router before their schemas are known. Tests
compare complete first and post-tool request inputs, instructions and schemas
for all three disclosure transports; they also cover the empty required-server
case, failures and cleanup before/after preparation starts.

This is a tool-lifecycle change and requires review even when request bytes are
equal. A catalog persistence failure can now happen after a text-only request
has begun; actual tool demand still fails at the existing fence. An immediate
eager tool call may wait for remaining catalog work, normally overlapped with
provider latency. Embedders opting into deferred timing should supply their
host-owned Skill catalog as the worker does: otherwise any descriptors derived
only from the completed execution catalog are not available at initial agent
construction. This change does not claim to remove the entire production
startup gap; paths that already deferred a connection already use this lifecycle.

The dispatch notification must also follow awaited request custody admission.
For plain HTTP it runs at fetch entry without an asynchronous gap; Responses
transports report from their existing HTTP/socket-send observer, after body
reading and handshake/fallback setup. Nested observers compose, so subscription
transport receipts and worker timing both receive the same fact. The worker uses
this notification for native subscription and generic routes, excluding auxiliary
calls. Its earlier starts from subscription admission/audit callbacks are removed.
The durable audit and custody checks stay before network I/O and are unchanged.

Starting catalog microtasks before those awaited gates lets synchronous catalog
work delay the request it is supposed to follow. Merely moving them to a later
event-loop iteration or observing streamed-body EOF does not establish remote
receipt. Native transport buffering and response handling can still wait on
catalog CPU. Compare the
separate mock provider's received timestamp as well as the request audit.
Catalog-phase telemetry for newly deferred paths changes from `blocking` to
`background`. This change does not offload or eliminate the catalog's CPU work.

### Remove unused validator compilation

Profiling a 171-entry execution catalog found about 804 ms in cold gateway
preparation, mostly schema compilation, despite only 15 tools being disclosed
and no tool being called. The existing process-wide compiled-schema cache
reduces warm compilation, but every eager preparation still hashes every schema
for its cache lookup. Moving this CPU work after the audit alone only moves the
delay: it can block streamed request transmission on the same event loop.

Compile a tool's input and output validators together at its first argument
validation, using the existing compiler, options and cache. Keep private schema
copies taken during preparation, the same validator instance for rejection and
repair, and the same live authorization and execution fences. Both validators
must compile before execution so an invalid output schema cannot fail after a
side effect. Retain compilation failures per definition as a typed unavailable
tool error, keeping the compiler failure as its cause. They are not
argument-validation failures and do not enter repair. The model sees that the
tool was not called and that changing its arguments will not fix the schema,
rather than the generic instruction to retry or raw compiler diagnostics.

This deliberately changes malformed-schema failure timing: an unused invalid
tool no longer prevents catalog preparation or other tools from working. Calling
that tool still fails before authorization and execution. The first call to a
valid tool pays its compilation cost if the existing process cache is cold.
For approval-gated calls that stop before argument validation, a malformed
schema may be reported only after approval rather than during preparation.
Catalog structure, digest and size validation are unchanged; schemas are not
rewritten. This behavior change also requires review before merge.

### Local measurements and limits

Same local stack, synthetic Responses provider in a separate process, standard
first-party catalog, no tools called and no sandbox. Each warm cohort has ten
fresh chats and ten follow-ups; the stack is explicitly restarted for each
variant and one warm-up pair is excluded. Times below are acceptance to the
provider's complete request receipt, not the earlier request audit.

| Cohort | Before median / p90 | Candidate median / p90 |
| --- | ---: | ---: |
| Fresh chat, warm process | 521.5 / 549 ms | 403.5 / 453 ms |
| Existing chat, warm process | 473 / 568 ms | 419 / 478 ms |

The single cold-process first request was 1,523 ms before and 912 ms with the
candidate. Its catalog-build span fell from 680 ms to 70 ms. A deferred-catalog
variant without lazy validators took 1,710 ms at the receiver despite recording
its audit at 937 ms; its catalog build still cost 748 ms. Cold samples are
individual observations, not percentile estimates.

Warm candidate catalog build still costs about 40–42 ms and can delay socket
progress and response handling. Copying all 171 tools' schemas took 4.65 ms
median / 6.63 ms p90 over twenty local repetitions; the private snapshot is kept.
These results are local, not production proof,
and do not explain or eliminate the full production startup gap. No arbitrary
timer, request buffering, worker thread or additional background refresh was
added. Discarded body-EOF/event-loop-yield experiments did not reliably remove
the receiver delay and are not part of the implementation.
