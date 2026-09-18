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

This foundation does **not** persist an API-admission context through Temporal
or claim one continuous API-to-worker trace. That requires an explicitly
versioned durable carrier and workflow replay compatibility work. Session IDs
must not be hashed into invented trace ancestry as a substitute.

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
bounded contract event types, exact UUID attempt/session/turn correlation and
the 40-hex deployment revision when configured. IDs belong in restricted log
bodies, never indexed metric labels. Unknown constraints and invalid IDs are
omitted. Source failure classification and retries remain owned by the DB layer.

Original causes are inspected before generic public error projection. At most
four causes and 32 frames per cause are retained. **Raw stack text and messages
are not retained**: even filenames/functions may contain secrets. Frames retain
SHA-256 source-location fingerprints and original line/column numbers, with a
closed error-kind vocabulary. This permits matching a known source location at
the recorded revision, but is not a readable original stack. A future readable
stack lane needs a reviewed source-location manifest, not heuristic redaction.
Property getters, `toJSON`, driver detail and arbitrary exception fields are
never invoked or copied. Original Error objects remain unmodified.

The independent diagnostic lane holds at most 256 queued records and one active
request. `opengeni_diagnostic_exports_total{outcome}` reports export outcomes and
`disabled` captures when no protected endpoint is configured. Fatal API capture
occurs before bounded flush and required exit(1). Session-event persistence
capture occurs before failure-settlement DB recovery work, so a second DB error
cannot prevent its enqueue. Startup failures before an observer is attached
still have only the existing safe fallback diagnostic.