# Application trace and failure-diagnostic boundaries

`packages/observability` owns the application export contract. Public logs and
traces keep their existing attribute projection; adding a diagnostic field does
not make it public. Raw exceptions, prompts, tool content, SQL and parameters
must not be serialized into telemetry.

## Context and timing

`withTraceContext` scopes identity through asynchronous calls. `startSpan`
inherits that identity and exports `parentSpanId`; explicitly passing
`parent: null` starts an independent root. The context contains only validated
nonzero trace/span IDs, not baggage or customer attributes. Links are limited
to eight validated identities. W3C traceparent helpers are provided for trusted
adapters; public HTTP headers are not automatically admitted as trusted context.

API requests and physical worker attempts each establish isolated roots.
Model-call, MCP-tool-call and startup-phase measurements export child spans
under the physical attempt. Completed duration measurements are siblings, not
claims that one completed operation caused another. Existing first-startup
phase deduplication is unchanged; model-call and MCP timing are per invocation.

Periodic capture cadence uses a durable attempt clock,
not only the last successful archive: a failed provider call releases its exact
admission gate but cannot immediately start another periodic capture on the next
heartbeat. The configured interval is a start-to-start cadence, not a maximum
recovery-point age. Forced finalization/recovery bypasses this cadence only; all
ownership, active-capture and possible-writer fences still apply.

Snapshot failure diagnostics preserve a closed provider
error name, numeric gRPC code (only for a typed ClientError), numeric HTTP status,
and boolean retryability from the SDK wrapper's structured details. They do not
log provider messages, request identifiers, response bodies or free-form causes.
Missing classification means unknown, not a timeout or a retryable failure.

Workspace capture admission is measured on every routed operation, including
operations after startup. `opengeni_sandbox_capture_wait_duration_seconds`
separates durable admission and provider capture gates using closed `stage`
labels. The matching `sandbox.capture_wait.admission` and
`sandbox.capture_wait.provider` spans carry only bounded backend/outcome values.
Wait observations do not increment physical provider-operation counters.
`opengeni_workspace_capture_duration_seconds` and `worker.workspace_capture`
measure physical warm capture/publication through gate cleanup, including late
settlement after the initiating caller times out. Capture/publication failure or
fenced publication is not reported as successful. Collector deployments must
retain these exact names to preserve attribution.

Consistent workspace capture intentionally fences new writing operations; a
shell command is conservatively a potential writer even when its text looks
read-only. Capture waits must not be removed by bypassing that fence or by
disabling recovery snapshots. Compare gate wait and physical capture duration
before changing capture strategy; filesystem and directory-only persistence
have different recovery semantics.

API Send, Steer and composer-submit emit `api.turn.admitted` only after successful
non-replayed admission. This real anchor span links to the HTTP request. Its
identity uses SHA-256 of `opengeni:accepted-event-trace:v1\0` plus the lowercase
server-generated, persisted event UUID: first 32 hex characters for trace ID,
next 16 for span ID. The worker loads the same durable trigger after claim and
links its physical-attempt span to that exact anchor. Retry attempts keep
independent roots linked to the original admission; they never manufacture a
parent relationship or republish the API anchor. Raw event IDs are not exported.

This is explicit causal linkage, not a continuous parent chain through Temporal.
No workflow payload, replay command, schema, or admission transaction changes.
Public traceparent headers and client idempotency keys cannot select the anchor.
Rejected/rolled-back admissions and replay responses do not mint anchors.
Non-API origins (including internal user-message producers), approval resumes,
and telemetry emitted before a trigger can be loaded do not yet have this full
link path. Export drops/sampling or process death between commit and observation
can leave a link without a retained target; links are best-effort observability,
never durable execution truth or proof an admission did not happen.

## Bounded export

Public traces use OTLP HTTP JSON at the existing endpoint plus `/v1/traces`.
Each observer batches up to 32 spans, with eight queued batches and one active
request; one additional partial batch can be held. Excess batches are dropped.
Transport failures receive at most three attempts with 25/50 ms backoff. The
built-in fetch has a one-second deadline. A custom exporter that never settles
holds one active slot; it does not cause detached overlapping retries.

`flush()` drains both lanes best-effort for one second by default, with a hard
five-second caller-configurable maximum. It cannot guarantee delivery on process
kill or exporter outage. `opengeni_telemetry_exports_total{outcome}` records
exported, retried, failed and dropped **batches**. No IDs become metric labels.

## Web client errors

The public, anonymous `POST /v1/client-errors` route counts browser failures in
`opengeni_client_errors_total{kind}` (`route_error`, `unhandled_rejection`,
`window_error`, `chunk_load`) and refusals in
`opengeni_client_error_reports_rejected_total{reason,kind}`; both are published
at zero on API start. `reason` is `invalid`, `too_large`, `origin` or
`rate_limited`. A `rate_limited` refusal keeps the report's `kind`, so accepted
plus rate-limited is the true per-kind arrival rate while a bucket is empty; the
other reasons use `kind="unknown"` because the report was not read or not valid.
The strict body is the kind, a route pattern and a bundle revision, under 512
bytes; the limit is enforced on the streamed body, so a chunked request is
refused after 512 bytes instead of being buffered, and the generic request-body
ceiling does not apply to this exact route. The wire grammar is shared by the
browser, the route and the log projection through
`@opengeni/contracts/client-error-report`.

A request whose `Origin` header is present but is not one of the deployment's
own web origins (the CORS allowlist, `OPENGENI_PUBLIC_BASE_URL` or
`OPENGENI_WEB_BASE_URL`) is refused as `origin`, so a foreign page cannot spend
the budget through its visitors' browsers. Admission is a per-kind token bucket
in each API process (burst 30, then one every two seconds), so a hostile or
looping client cannot inflate the counter or the log without bound. Each
accepted report writes one `Web client error reported` warning whose public
fields are `surface`, `reason` (the kind), and the grammar-validated opaque
`clientRoute` and `clientRevision`. No message, stack or URL is accepted.

The route is anonymous and a non-browser client can omit or forge `Origin`, so
the counter can be spoofed up to the admission ceiling (about 43,000 reports per
kind per API process per day). Alert on rates and on ratios such as
`route_error` against HTTP request volume, not on absolute counts, and read a
rising `rate_limited` series as either a real incident or abuse. See
`apps/web/docs/browser-analytics.md` for the browser side, the `chunk_load`
semantics and the coverage limits.

## Protected diagnostics

Set `OPENGENI_OBSERVABILITY_DIAGNOSTICS_ENDPOINT` only to an operator-controlled,
access-restricted OTLP logs receiver. The application adds `/v1/logs`. Optional
`OPENGENI_OBSERVABILITY_DIAGNOSTICS_HEADERS` are separate from public exporter
headers. There is no default endpoint, public OTLP fallback, or stdout fallback.
Operators must configure restricted storage, access controls, retention,
encryption in transit, and query-back verification before claiming retention.
Ordinary public logs are not a substitute for this protected receiver.

The OTLP scope is `@opengeni/observability/diagnostics`, version `1`. Log bodies
contain JSON with schema `opengeni.failure-diagnostic.v1`: a generated diagnostic
UUID, closed code/stage/retry decision, reviewed constraint names, SQLSTATE,
bounded contract event types, exact UUID attempt/session/turn/process correlation and
the 40-hex deployment revision when configured. IDs belong in restricted log
bodies, never indexed metric labels. Unknown constraints and invalid IDs are
omitted. Source failure classification and retries remain owned by the DB layer.

Retained-command proof writes use `sandbox_retained_processes.proof`. Typed
ownership-fence failures have code `retained_process_fenced`; database failures
retain SQLSTATE and reviewed proof/claim/settlement constraint names. Other
failures use `retained_process_proof_failed`. The public warning carries only the
diagnostic UUID. Inspect the protected cause location before treating a warning
as a persistent defect: a concurrent owner may already have settled the process.
This instrumentation neither releases claims nor changes retry or settlement.

Original causes are inspected before generic public error projection. At most
four causes and 32 frames per cause are retained. **Raw stack text and messages
are not retained**: even filenames/functions may contain secrets. Frames retain
SHA-256 source-location fingerprints and original line/column numbers, with a
closed error-kind vocabulary. Reviewed exact repository/bundle source paths in
`DIAGNOSTIC_SOURCE_FILES` additionally retain their relative `source` name;
arbitrary host prefixes, unknown files and function names are never copied.
Unknown frames remain hash-only, not a readable original stack. Nested
`PostgresError.where` retains only function names in
`DIAGNOSTIC_POSTGRES_FUNCTIONS` and numeric line numbers, at most eight contexts.
All SQL statements, arguments and free-form context remain excluded. The exact
`session_attempts.claim` stage supports diagnostics before admission settlement.
Expand these registries only by reviewed source changes, not regex redaction.
Property getters, `toJSON`, driver detail and arbitrary exception fields are
never invoked or copied. Original Error objects remain unmodified.

The independent diagnostic lane holds at most 256 queued records and one active
request. `opengeni_diagnostic_exports_total{outcome}` reports export outcomes and
`disabled` captures when no protected endpoint is configured. Fatal API capture
occurs before bounded flush and required exit(1). Session-event persistence
capture occurs before failure-settlement DB recovery work, so a second DB error
cannot prevent its enqueue. Startup failures before an observer is attached
still have only the existing safe fallback diagnostic.