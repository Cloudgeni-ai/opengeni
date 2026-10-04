# Launch burst preparation

**Prepared, not executed. This is not a load-test PASS.** Live execution requires
both staging gates and a **new capacity-parent message authorizing the exact wave**.
No tiny smoke, signup, model prompt, session, sandbox create/shell, server allowlist
change, CI dispatch, deployment, or production action is part of preparation.

## Reused source paths

- `scripts/operator/connected-machine-load-profile.ts`: bounded execution and
  nearest-rank quantiles only. Its warm-up and direct terminal load runner are NOT run.
- `packages/sdk/src/sse.ts`: production incremental SSE parser, including fragmented
  UTF-8/CRLF and cancellation. Gaps/closes are explicit failures, not hidden retries.
- `packages/runtime/src/sandbox/exec-banner.ts`: only SDK metadata before `Output:`
  proves command exit. A forged exit line in command output is not proof.
- `test/e2e/organization-onboarding-acceptance.e2e.ts`,
  `apps/api/test/managed-onboarding.test.ts`,
  `apps/api/test/managed-auth-session-sets.integration.test.ts`: public verified
  signup and normal name-only organization setup / Personal workspace. Database
  seeding, synthetic verification, admin keys, and setup invitation shortcuts are
  not reused.
- `packages/config/src/index.ts` and `packages/core/src/default-session-model.ts`:
  actual `gpt-6-luna` credits default / `xhigh`, not an invented model alias.

Every new file is in this subtree. The standalone `tsconfig.json` deliberately
avoids edits to worker-owned shared script configuration. Unit discovery already
discovers `*.test.ts`; run this isolated typecheck explicitly.

## Separate waves

| Intent | Participants | First turn | Model choice |
| --- | ---: | --- | --- |
| `plain.intent.json` | 100 existing-user sessions | Just `OK`, no tools or sandbox | Explicit `gpt-6-luna`, `low` |
| `sandbox.intent.json` | 100 existing-user sessions | Exactly one `/bin/true` exec, terminal exit, then `OK` | Explicit `gpt-6-luna`, `low` |
| `fresh50.intent.json` | 50 genuinely fresh signups | Same one-command first turn | Omit model/effort; assert actual credits Luna `xhigh` |
| `fresh100.intent.json` | 100 **different** fresh signups | Same one-command first turn | Omit model/effort; assert actual credits Luna `xhigh` |

Each wave gets its own run ID, identity cohort, authorization, output, and
before/during/after telemetry window. No automatic second wave or retry exists.
First authenticate/onboard and verify defaults, then release all ready prompt
creates together. `promptLaunchSpreadMs` reports actual client launch skew;
record whether it is below one second, rather than merely calling it simultaneous.
Failed signup/default preparation stays in the original all-user denominator.

Fresh flow: public `/v1/auth/sign-up/email` → actual delivered verification link →
public legacy sign-in or isolated session-set transaction/select → verified
`get-session` identity → required onboarding with no memberships →
`organization-onboarding` (`useCase: cloud`) → exactly one Personal membership →
workspace `model-catalog` with `defaultSelection.source=credits`, Luna, `xhigh` →
normal `POST sessions` **without** model or effort. Signup response identity/date
must match the verified human, and the account must have been created in this
signup request (one-second clock-skew tolerance). Missing evidence fails closed.
The runner neither grants credits nor saves defaults nor connects subscriptions.
Collect normal verified-signup trial ledger provenance through Monitoring where
available; model-catalog evidence alone is not a claim about the grant amount.

## Offline commands (safe now)

```bash
bun --no-env-file test scripts/operator/launch-burst/offline.test.ts
bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p scripts/operator/launch-burst/tsconfig.json
bun --no-env-file run scripts/operator/launch-burst/run.ts
bun --no-env-file run scripts/operator/launch-burst/run.ts --dry-run --intent scripts/operator/launch-burst/sandbox.intent.json
bun --no-env-file run scripts/operator/launch-burst/run.ts --dry-run --intent scripts/operator/launch-burst/fresh50.intent.json
bun --no-env-file run scripts/operator/launch-burst/run.ts --dry-run --intent scripts/operator/launch-burst/fresh100.intent.json
```

Default execution prints only intent, its canonical SHA-256, and zero remote
requests. It does not inspect cohort credentials, invoke mailbox/checkpoint/stop
callbacks, or fetch configuration. Offline fixtures inject an in-memory transport;
they do not start even a loopback app/Temporal/DB/model/sandbox service.

## Gated execution recipe — DO NOT RUN yet

The capacity parent alone issues authorization **after** reliability confirms API
memory/OOM, worker cleanup self-termination, empty output, and stuck wakes fixed
on staging, and Monitoring confirms Launch dashboard LIVE on staging. Shape checks
cannot authenticate those external confirmations; the parent's independently held
token plus immutable message/confirmation references are operator evidence, not
automatic gate detection. There is no approval generator in the harness.

Keep private inputs/results outside the repository. Cohort schema:

```json
{"schemaVersion":1,"identities":[
  {"kind":"existing","label":"wave-user-001","workspaceId":"<UUID>","cookieEnv":"BURST_HUMAN_COOKIE","actorEpoch":"<selected epoch if session-set>"}
]}
```

For fresh cohorts replace each entry with
`{"kind":"fresh","label":"fresh-001","email":"<new owned test address>","passwordEnv":"BURST_TEST_PASSWORD","organizationName":"Launch test 001"}`.
There must be exactly the intended number of unique labels/emails; fresh and
existing identities cannot be mixed. Existing cookies are canonical managed-human
cookies, never bearer/admin credentials. Export credentials into the operator's
environment without printing them. The local cohort is an explicit identity
allowlist; the runner never changes server allowlists, rate limits, or flags.

The parent's private authorization JSON must match `Authorization` in `config.ts`:
`schemaVersion=1`, parent session ID, actual checked-out full `sourceSha`, dry-run
`intentDigest`, raw cohort file `cohortDigest`, `gateTokenDigest`, reliability's
four true fix flags + dated confirmation reference, Monitoring's true staging
dashboard flag + dated confirmation reference, later parent `authorizationRef`,
`issuedAt`, and `expiresAt` (at most 30 minutes later). Export
`OPENGENI_BURST_PARENT_SESSION_ID` and a new independent secret
`OPENGENI_BURST_GATE_TOKEN` (at least 32 characters). The token is never placed in
argv or output. Head/intent/cohort drift, wrong token/parent, missing flags, or
expired/premature approval rejects **before any remote request**.

After the parent has explicitly authorized **that** exact intent:

```bash
bun --no-env-file run scripts/operator/launch-burst/run.ts \
  --intent scripts/operator/launch-burst/plain.intent.json \
  --cohort "$BURST_PRIVATE_DIR/plain-cohort.json" \
  --authorization "$BURST_PRIVATE_DIR/plain-authorization.json" \
  --output "$BURST_PRIVATE_DIR/plain-result.json" \
  --stop-file "$BURST_PRIVATE_DIR/STOP" \
  --execute --confirm-parent-authorized
```

For sandbox use `sandbox.intent.json` and sandbox-specific cohort/authorization/
result paths. For fresh 50, then separately authorized fresh 100, use the matching
intent and paths **plus** `--verification-dir "$BURST_PRIVATE_DIR/mailbox"`.
The authorized current mailbox owner deposits a mode-0600 regular
`<label>.json` containing only `{ "email": "<same address>", "url": "<actual delivered link>" }`.
The file is private secret input, never a result artifact. Links/callbacks must be
same-origin staging verification paths; redirects are not followed. No paid
integration is added; without an actual authorized mailbox this mode is blocked,
not silently seeded or marked verified.

The CLI refuses a dirty harness, reserves output with `wx`/0600, and consumes an
adjacent `<authorization>.consumed` file before any fetch. Never remove that receipt
to retry; have the parent reconcile outcomes and authorize a new wave. Checkpoints
are serialized, content-free, and durable. The first accepted-session receipt
records both the requested UUID and returned UUID, helping reconcile uncertain
create outcomes without replay. Keep exact-harness source SHA, actual deployed
release, run ID and UTC windows with the result.

## Measurements and acceptance

- Client monotonic TTFT: immediately before initial session/prompt POST to first
  non-whitespace `agent.message.delta`/`completed` text on that exact first turn.
  User/status/reasoning/tool frames and other turns do not count. Subscription
  starts after acceptance, so replayed output is measured when the client receives
  it; this is not a server-only inference latency.
- Acceptance: successful session POST return. Worker start: client observation
  of the earliest `turn.started` on the exact first turn; later recovery/resume
  starts do not overwrite it, including when the first observed latency is zero.
  It includes API/network/dispatch/replay, **not raw Temporal schedule-to-start**.
  Database `session_turns.started_at` can be overwritten on recovery/resume and
  must not be treated as first-start or raw Temporal Scheduled→Started latency.
  Acceptance→latest-resume observations from existing traffic are not a burst
  baseline. Optional event-time receipt→first-output is separately named.
- Signup: monotonic start of actual signup/auth preparation through completed
  onboarding. It is separate from prompt TTFT and barrier wait; failures have null
  signup latency, not zero. Exact first-turn/attempt IDs and correlation IDs are
  retained without text, tool output, emails, cookies, verification URLs or secrets.
- Sandbox: client observation and server duration of `sandbox_establish` where
  present; these are broader establishment phases, **not raw provider create or
  readiness durations**. `/bin/true` tool-call→authoritative SDK terminal exit is
  separate. Missing phase/readiness telemetry stays unknown. Plain probes with
  unexpected tools, extra commands, unknown/nonzero exit, empty output, turn
  failure/cancel/supersession, stream gap/close and deadlines are not successes.
- Exact nearest-rank `ceil(p*n)` p50/p95/p99/max from raw milliseconds. Missing
  observations sort as +Infinity and render `unobserved_or_failed`; no tail is
  clamped to 10 seconds or dropped. All original participants stay in success,
  TTFT and successful-completion denominators. Successful-only TTFT is explicitly
  secondary. No initial-attempt failure is replaced by a retry.
- Acceptance target: ≥99% first-turn success and **all-user** client TTFT p95
  <10 seconds, per wave. At 50 users one failure already fails 99%; at 100, one
  failure is 99%. Telemetry, cleanup and capacity acceptance remain separate
  `not_evaluated`, even when the client targets pass.

`opengeni_turn_startup_milestone_duration_seconds_bucket{milestone="first_byte",outcome="completed"}`
is prompt-receipt→reply, completed-outcome only. It is not an all-user success
metric. The pre-extension `STREAM_TTFT_BUCKETS` finite upper bound of 10 seconds
censors the tail; the worker owner extends it. This subtree changes no metrics.

After each wave, Monitoring should export **only** content-free exact workflow/run/
session/turn/activity IDs and `runAgentTurn` ActivityTaskScheduled/Started event IDs
and UTC timestamps. Correlate Started `scheduledEventId` to Scheduled `eventId`
within the same exact run. Retain each retry start; absent starts are pending/unknown,
not zero. A workflow-wide export cannot attribute a logical turn without the
existing attempt/activity fence mapping; preserve `turnId:null` when unavailable.
Never save/log raw history, inputs, results, heartbeat payloads or secrets.

```bash
bun --no-env-file run scripts/operator/launch-burst/analyze.ts "$BURST_PRIVATE_DIR/temporal-metadata.json"
```

This analyzer is offline only and rejects payload-bearing/extra metadata fields.
Without Monitoring's metadata export, Temporal schedule-to-start is unsupported,
not approximated from receipt→worker or an aggregate task-queue histogram.

## Monitoring collection / cutoffs

Coordinate read-only exports with the live Launch dashboard owner before execution:
10 minutes before signup begins, every 15 seconds through signup/prompt/terminal
windows, then at least 30 minutes after settlement or the configured scale-down
cooldown plus rollout time. Mark actual UTC first/last prompt and final terminal
times. Preserve missing samples, release changes and collection failures explicitly.
SQLSTATE `57014` from a collection query (statement timeout/query cancellation)
means failed collection and unknown values, **never a healthy empty queue or zero**.
Retain the collection error and query/export provenance; missing values remain
null/unknown rather than being fabricated from a failed query.

Collect API/control/turn worker desired/current/Ready/pending replicas and restart/
OOM reasons; node Ready/allocatable/requested CPU/memory, unschedulable reasons,
autoscaler limits/headroom and scaler activation/pressure; Temporal task-queue and
exact activity waits/errors/backlog; NATS disconnect/reconnect/pressure; DB CPU,
connections/max, IOPS/latency/locks and pool saturation; ingress/auth/model 429s and
5xx; sandbox create/readiness/capacity/unknown operation counts. For each
before/during/after window, record node pool identity, node SKU, CPU architecture
and CPU model where observable; regional and per-family quota limits, usage and
remaining headroom as distinct scopes; infrastructure and application source
revisions, deployed image identities/releases and metric-query/export provenance.
Timestamp changes so code, CPU and host changes are attributable, not blended into
one comparison. Unavailable metadata stays null/unknown; do not infer CPU model
from SKU or fabricate quota headroom. This is an owner-supplied telemetry plan,
not a collector implemented by the harness. Show actual scale-up timing and
eventual scale-back to the admitted baseline; a desired replica increase without
Ready pods is not capacity. Missing observability is work, not PASS.

Parent cutoffs: any new API OOM or worker cleanup self-termination, rising stuck/
empty/unknown operations, >1% initial failures, sustained DB pressure (e.g. CPU or
connections >80% of the admitted limit), missing critical telemetry, or cost budget
reached. Write the supplied STOP file: admission checks cease new prompt work;
local in-flight stream waits check it at most every 250 ms. **Aborting client
observation does not cancel already accepted server/model/provider work.** Parent
must reconcile exact IDs and use normal public Pause/cleanup when authorized.

Terminal turns request public quiescence-fenced session DELETE once, never direct
Modal shell/stop/create. A rejected cleanup remains `failed`; it does not prove
physical sandbox deletion. Unknown/timeouts retain `held_unknown` and get no DELETE.
The owner retains content-free identity/result artifacts before destructive cleanup
and verifies physical scale-back/provider settlement separately.

## Known execution limits

- Public auth uses real ingress/client-IP rate limits. Current source permits 20
  signups/minute per client; one egress IP cannot truthfully emulate 50–100 distinct
  client IPs. Do not spoof forwarding headers or relax auth limits. The parent must
  use already-authorized genuine client topology, or explicitly interpret a
  single-egress wave as a throttling test, not 99% launch acceptance. This runner is
  one process/egress; distributed signup orchestration is not implemented here.
- An actual owned mailbox and compatible staging auth configuration are required.
  No OAuth provider, mail delivery integration or server allowlist is provisioned.
- Example USD caps ($5 plain, $10 sandbox, $10/$20 fresh 50/100) are conservative
  **admission reservations**, not estimates of measured bills or hard provider caps.
  Source has no per-session create-request hard USD cap. Monitor billed/model/
  sandbox cost through existing authorized telemetry and STOP at the parent cap;
  in-flight/provider/model reasoning costs can overshoot. Do not claim a hard cap.
- No live staging compatibility, signup delivery, provider quota, Temporal export,
  cleanup quiescence, autoscale, DB headroom or launch acceptance is established
  by offline fixtures. Exact-source independent review and targeted checks must
  complete before source merge; no manual CI dispatch or protection changes.