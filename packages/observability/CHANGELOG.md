# @opengeni/observability

## 5.3.1

### Minor Changes

- e0b3ccf: API request traces can now be followed across service boundaries and show where a request spends its time. A request's W3C `traceparent` header is no longer ignored: by default the request span keeps its own trace and links to the caller's span, and a deployment whose callers are all trusted can set `OPENGENI_OBSERVABILITY_TRUST_INCOMING_TRACE_CONTEXT=true` to make the request span a child in the caller's trace. Request spans are now SERVER spans with child spans for each database statement and transaction, each outbound HTTP call, and each object storage and workflow client call, within a budget of 256 per request. Span attributes carry only the statement's operation and table or routine name, row counts, SQLSTATE codes, HTTP methods and statuses: never SQL text, parameters, URLs or messages. Telemetry export no longer runs inside the trace it exports. New observability exports: `startChildSpan`, `childSpanRecordingActive`, `withoutTraceContext`, `traceFetch` and `traceClientCalls`, plus `kind` and `childSpanLimit` options on `startSpan`.

### Patch Changes

- c8ddf55: A browser or computer action batch that legitimately runs longer than a minute (for example waiting for an upload, filling a field, pressing Enter and then waiting up to 90 seconds for a reply) now completes and returns its normal receipt instead of failing with "The workspace is temporarily unavailable". Each action request gets a deadline derived from its own declared waits: the sum of each action's longest wait, plus the settle after page input, plus a fixed margin. It is never less than the previous one minute and never more than 20 minutes. Every layer that carries the request honours that deadline: the API's controller request on every transport, the Connected Machine runner (whose cap rises from 15 to 20 minutes) and its reply timer, the socket idle timers of the API-to-controller and tool-to-API requests, and the API and browser controller servers, which no longer apply their idle timeout to a running action. A request that still outlives its deadline (or an older runner's 15-minute cap) is not retried and returns `504 action_timeout`, telling the agent that the action may still be running and to check the page or window before doing anything again. `@opengeni/contracts` exports the shared wait and settle bounds and `browserActionDeadlineMs` / `computerActionDeadlineMs`.
- 826b002: Agents can find and read recorded meetings with two new first-party tools. `meetings_search` finds the meetings the person can see by words said or in the title, a named speaker, a start-time range or a product's reference, newest first, with each meeting's speakers and the transcript lines that matched. `meeting_read` reads one meeting's details and its transcript as speaker-named, timestamped lines with names and corrections applied, in parts or for a stretch such as 12:00 to 15:00, and reads the live preview while a meeting is still being recorded. Both are searchable (deferred) tools in the knowledge group and need `sessions:read`. The recordings list in the API and SDK also gains `person`, `startedFrom` and `startedTo` filters.
- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [fb72b9d]
  - @opengeni/contracts@5.2.0

## 5.1.2

### Patch Changes

- @opengeni/contracts@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0

## 4.8.0

### Patch Changes

- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/contracts@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0

## 4.6.1

### Patch Changes

- @opengeni/contracts@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [f838cb7]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0

## 4.4.1

### Patch Changes

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0

## 4.3.1

### Patch Changes

- e907c46: Separate HTTP duration histograms by bounded status class so successful request latency can be measured independently of fast failures. Existing queries that aggregate all status classes retain historical continuity; success-only queries require newly emitted samples.
- 46a2ef3: A computer or browser driver failure (`driver_failed`) now tells operators what failed. The controller sends the failing error class and function beside the unchanged error, and server logs record them with the driver message's code-written part, with window titles, page text, paths and free-text reasons redacted. The controller's own log line for a failed request is redacted the same way and now also covers known driver failures. What callers and agents are shown does not change.
- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/contracts@4.3.0

## 4.2.0

### Patch Changes

- 25c316a: Preserve safe operational error diagnostics and correlation without exposing raw errors or private identifiers in public logs.
- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
  - @opengeni/contracts@4.2.0

## 4.1.3

### Patch Changes

- @opengeni/contracts@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0

## 4.0.4

### Patch Changes

- 08a7a88: The on-demand CPU profile log line now carries its summary (busy time, longest block, top functions and the longest block's stack). Before, the structured logger dropped those attributes, so only the report file inside the container had them.
- 6f005fa: On Bun, the Prometheus scrape no longer collects the per-space `nodejs_heap_space_size_*` default metrics. Bun computes them from a full heap census that blocked the event loop for hundreds of milliseconds at every scrape, stalling every request in flight on API and worker processes. Heap totals remain available from `nodejs_heap_size_*` and `process_heap_bytes`.
- b1c5753: The package build keeps Bun's built-in `bun:jsc` profiler external, so CPU sampling no longer breaks the bundle.
- Updated dependencies [e7113e3]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
  - @opengeni/contracts@4.0.0

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0

## 3.2.2

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/contracts@3.2.0

## 3.1.2

### Patch Changes

- 0b164a9: Unexpected request and Channel-A failures now say which component refused them. The failure logs carry the reviewed class of the underlying error, plus the browser or computer controller's closed error code and status, the connected machine's error number, or the database SQLSTATE when there is one. Browser and computer operations are now named in Channel-A failure logs too. Messages, paths and identifiers are still never logged.
- Updated dependencies [17d61c6]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1

## 2.0.0

### Patch Changes

- bfed4f1: Web client error reports now say why a page failed, not only where: the beacon carries the error's name, message and stack, plus React's component stack for a render failure. The browser and the API apply one shared projection that removes URL query strings, redacts obvious credentials and bounds each field, and the API logs the result as `clientErrorName`, `clientErrorMessage`, `clientErrorStack` and `clientComponentStack` on the `Web client error reported` line.
- 1489689: Make product-level failures visible and alertable: every rejected API request is counted and logged with a bounded error code, missing-permission/domain reason, and content-free message fingerprint; Browser/Computer operations (including observe, tabs, and handoff attach) report outcome and failure reason; agent-opened handoffs and their expiry are counted; Connect attempts, provider OAuth callbacks, MCP OAuth starts, Connected Machine connects/enrollment, attached-browser reachability, and agent tool calls by closed tool family get low-cardinality metrics; new PrometheusRule alerts cover abnormal per-route refusals, missing-permission spikes, refused handoffs, and each product surface.
- aa0f483: Route Temporal SDK and core logs through the structured logger. Each record is one JSON line, and task tokens, identifiers and raw errors are projected out.
- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [71c42bf]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0

## 1.4.4

### Patch Changes

- 2edfa4c: Spans are batched on a short timer (up to 256 per OTLP request) instead of per microtask, so busy workers no longer overflow the bounded export queue and drop spans.
- Updated dependencies [6384dbd]
  - @opengeni/contracts@1.4.4

## 1.4.3

### Patch Changes

- @opengeni/contracts@1.4.3

## 1.4.2

### Patch Changes

- @opengeni/contracts@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [9145bad]
- Updated dependencies [f290348]
  - @opengeni/contracts@1.4.1

## 1.4.0

### Patch Changes

- Updated dependencies [bd9521c]
- Updated dependencies [08ce841]
- Updated dependencies [673bb53]
  - @opengeni/contracts@1.4.0

## 1.3.0

### Patch Changes

- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

- Updated dependencies [178b5ae]
- Updated dependencies [414d416]
  - @opengeni/contracts@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies [21c8904]
- Updated dependencies [d870f32]
  - @opengeni/contracts@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [5fd6c55]
- Updated dependencies [c600e3a]
- Updated dependencies [411b3b5]
- Updated dependencies [208dec1]
  - @opengeni/contracts@1.1.0

## 1.0.2

### Patch Changes

- f9e33b5: Retain bounded HTTP method, route, cause-kind and diagnostic correlation in error logs without exposing request contents or exception text. Record protected cause diagnostics for unexpected API failures.
- Updated dependencies [4476ca7]
- Updated dependencies [e16aa17]
  - @opengeni/contracts@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.8.39

### Patch Changes

- 81a5d9d: Retain bounded, redacted diagnostic evidence for unexpected first-party session creation, messaging and steering failures. Correlate the failed-tool receipt and optional protected export using one diagnostic ID and the signed caller attempt; preserve original error classifications and mutation uncertainty even when diagnostics are disabled or unavailable.
- Updated dependencies [aa41b15]
- Updated dependencies [af57cf9]
- Updated dependencies [8ce490f]
- Updated dependencies [692a1f5]
- Updated dependencies [e0d4bd4]
- Updated dependencies [c7c09fd]
- Updated dependencies [2f09c54]
- Updated dependencies [303ed6c]
- Updated dependencies [9ca494c]
- Updated dependencies [3395acc]
- Updated dependencies [18216d2]
- Updated dependencies [746464c]
- Updated dependencies [6cdc0aa]
- Updated dependencies [0fba21e]
- Updated dependencies [97d4f07]
- Updated dependencies [14e95e9]
- Updated dependencies [8323e90]
  - @opengeni/contracts@5.8.0

## 0.8.38

### Patch Changes

- 131eda2: Release unused telemetry exporter response bodies after receiving headers.
- Updated dependencies [12ef019]
- Updated dependencies [45e1b4f]
- Updated dependencies [da4ba6f]
- Updated dependencies [697263e]
- Updated dependencies [56584f9]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [cbb3e36]
- Updated dependencies [479ec20]
- Updated dependencies [70af8bb]
- Updated dependencies [3a921bf]
  - @opengeni/contracts@5.7.0

## 0.8.37

### Patch Changes

- Updated dependencies [e5b0123]
- Updated dependencies [4762e1a]
  - @opengeni/contracts@5.6.0

## 0.8.36

### Patch Changes

- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [45d1301]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
  - @opengeni/contracts@5.5.0

## 0.8.35

### Patch Changes

- 32598eb: Expose content-free MCP phase timings and host-owned outbound trace correlation across gateway, credential, transport and persistence boundaries. Preserve W3C sampling flags, credential header semantics, exact execution authority and existing retry behavior.
- Updated dependencies [01f50bf]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [872391f]
- Updated dependencies [aad6598]
- Updated dependencies [6146167]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [a6854a7]
- Updated dependencies [b591ea1]
- Updated dependencies [a82657f]
- Updated dependencies [cabfc5e]
- Updated dependencies [8669490]
- Updated dependencies [7a08660]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [30414a0]
- Updated dependencies [514f8ea]
- Updated dependencies [b28d5fa]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [bcd9988]
- Updated dependencies [d1f4724]
  - @opengeni/contracts@5.4.0

## 0.8.34

### Patch Changes

- b9482ea: Include the configured deployment revision and an opaque runtime instance ID in
  OTLP trace and protected-diagnostic resources without adding metric labels or
  exposing host or user identities.
- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
- Updated dependencies [3aab8f9]
  - @opengeni/contracts@5.3.0

## 0.8.33

### Patch Changes

- c1756ef: Make operational signals truthful: the session recovery backlog no longer counts effectively paused sessions as stale, a read-only first sandbox probe that finds no path is recorded as a completed startup phase, Knowledge index deferrals log a content-free cause, and repeated warnings can be throttled per key with a suppressed count.
- bd365b7: Add a public, content-free `POST /v1/client-errors` beacon that counts web
  client failures in `opengeni_client_errors_total{kind}` with per-kind admission
  bounds, a streamed 512-byte body limit and a same-deployment `Origin` check, and
  admit its grammar-validated route pattern and bundle revision in public
  structured logs. The shared wire grammar is exported from
  `@opengeni/contracts/client-error-report`.
- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
- Updated dependencies [48a8774]
- Updated dependencies [e422b62]
- Updated dependencies [bd365b7]
  - @opengeni/contracts@5.2.0

## 0.8.32

### Patch Changes

- Updated dependencies [23f4717]
  - @opengeni/contracts@5.1.1

## 0.8.31

### Patch Changes

- Updated dependencies [d92af11]
- Updated dependencies [f60ca2b]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/contracts@5.1.0

## 0.8.30

### Patch Changes

- c6f98cc: Preserve bounded provider error classifications and opaque lease correlation for drain capture failures, without exposing provider messages or allowing logging failures to interrupt recovery cleanup.
- c702159: Stop retrying permanent runtime database posture and configuration failures as
  connection errors. Validate local startup prerequisites, prevent overlapping
  launchers from rotating live database credentials, and check database posture
  before building the development sandbox.
- 406a62e: Link each worker execution trace to one structured start log through a stable opaque correlation key derived from authorized workspace, session and attempt records. Keep raw identities out of public telemetry and correlation keys out of metric labels.
- 9d9b94b: Keep the published dependency closure aligned with the updated plugin removal
  contracts. The SDK exposes named removal outcomes and optional preview-token
  confirmation alongside the existing installation-version check.
- a6251eb: Add isolated async trace context, parent/link export, bounded trace batching and
  retry health, and opt-in protected failure diagnostics independent of the
  application database. Preserve the public telemetry privacy projection.
- 6f82814: Retain bounded protected diagnostics for retained-process proof-write failures, linking public warnings without exporting process identities or error text.
- d3672c0: Measure workspace capture gate waits on every routed sandbox operation, including
  mid-turn and API-direct operations, without changing provider-call accounting or
  admission guarantees. Record physical warm capture and publication duration at
  actual settlement, including captures that outlive the initiating caller.
- d84b1a3: Preserve sandbox visibility-check command evidence in durable turn failures and
  expose bounded, explained failure categories on the Runtime Failures dashboard.
- e261718: Preserve bounded provider error classifications in workspace snapshot diagnostics without logging provider messages, request identifiers or payloads.
- b384b43: Record workflow wake transport and durable admission outcomes separately, with bounded blocker metrics and useful public log fields.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [aa09567]
- Updated dependencies [d1ab270]
- Updated dependencies [c8bb974]
- Updated dependencies [3fa175e]
- Updated dependencies [332a02d]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [621201d]
- Updated dependencies [f90d628]
- Updated dependencies [1bfb6a4]
- Updated dependencies [7e2436a]
- Updated dependencies [9d9b94b]
- Updated dependencies [c66ba31]
- Updated dependencies [f7c9169]
- Updated dependencies [0ea365c]
  - @opengeni/contracts@5.0.0

## 0.8.29

### Patch Changes

- Updated dependencies [7746251]
- Updated dependencies [85cafd0]
  - @opengeni/contracts@4.1.0

## 0.8.28

### Patch Changes

- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [123cf57]
- Updated dependencies [efeaa9c]
  - @opengeni/contracts@4.0.0

## 0.8.27

### Patch Changes

- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/contracts@3.1.0

## 0.8.26

### Patch Changes

- Updated dependencies [e1a50ba]
  - @opengeni/contracts@3.0.2

## 0.8.25

### Patch Changes

- Updated dependencies [6a60a58]
  - @opengeni/contracts@3.0.1

## 0.8.24

### Patch Changes

- Updated dependencies [cffd21b]
- Updated dependencies [f8be7df]
- Updated dependencies [cffd21b]
  - @opengeni/contracts@3.0.0

## 0.8.23

### Patch Changes

- Updated dependencies [1b0f4f2]
  - @opengeni/contracts@2.15.2

## 0.8.22

### Patch Changes

- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/contracts@2.15.1

## 0.8.21

### Patch Changes

- Updated dependencies [231b103]
- Updated dependencies [392c575]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/contracts@2.15.0

## 0.8.20

### Patch Changes

- Updated dependencies [22a6704]
- Updated dependencies [4536385]
- Updated dependencies [7dac7e3]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [c1dc59b]
- Updated dependencies [1fc0889]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [c69ad5f]
- Updated dependencies [1c4b707]
- Updated dependencies [c90f3fc]
- Updated dependencies [414946c]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/contracts@2.14.0

## 0.8.19

### Patch Changes

- Updated dependencies [6b65383]
  - @opengeni/contracts@2.13.0

## 0.8.18

### Patch Changes

- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/contracts@2.12.0

## 0.8.17

### Patch Changes

- Updated dependencies [38de50d]
- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/contracts@2.11.1

## 0.8.16

### Patch Changes

- Updated dependencies [8f81b57]
  - @opengeni/contracts@2.11.0

## 0.8.15

### Patch Changes

- Updated dependencies [2d0fad4]
- Updated dependencies [9fe5c5b]
- Updated dependencies [c356468]
- Updated dependencies [9af1666]
  - @opengeni/contracts@2.10.0

## 0.8.14

### Patch Changes

- Updated dependencies [5b9acd1]
  - @opengeni/contracts@2.9.2

## 0.8.13

### Patch Changes

- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/contracts@2.9.1

## 0.8.12

### Patch Changes

- Updated dependencies [699477a]
- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
- Updated dependencies [88b6b48]
  - @opengeni/contracts@2.9.0

## 0.8.11

### Patch Changes

- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/contracts@2.8.0

## 0.8.10

### Patch Changes

- Updated dependencies [c116379]
  - @opengeni/contracts@2.7.1

## 0.8.9

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/contracts@2.7.0

## 0.8.8

### Patch Changes

- 09beefa: Attribute fatal API startup and runtime failures with secret-safe structural diagnostics, drain pending OTLP exports for a bounded interval, and preserve the required nonzero process exit.

## 0.8.7

### Patch Changes

- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/contracts@2.6.0

## 0.8.6

### Patch Changes

- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0

## 0.8.5

### Patch Changes

- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/contracts@2.4.0

## 0.8.4

### Patch Changes

- 4d83368: Separate worker-claim queue state from prompts genuinely waiting behind work, keep rapid sends on stable chat and queue surfaces, and make local development fail fast when schema or aggregate runtime readiness is lost.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0

## 0.8.3

### Patch Changes

- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/contracts@2.2.0

## 0.8.2

### Patch Changes

- Updated dependencies [ab81e47]
  - @opengeni/contracts@2.1.1

## 0.8.1

### Patch Changes

- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [5b509be]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [48b9f09]
  - @opengeni/contracts@2.1.0

## 0.8.0

### Minor Changes

- 747222a: Add content-free compatibility-lane telemetry for the organization-tenancy migration. `opengeni_tenancy_compatibility_lane_uses_total{lane}` counts live uses of a bounded legacy lane - a `legacy_user` connection resolved for accepted use, a workspace-scope connection ref with no connection id taking the pre-snapshot resolution, and a `/workspace` mutation refused `authority_unattributed`. The closed lane set is `TENANCY_COMPATIBILITY_LANES`; the lane name is the only label, an unreviewed name is ignored instead of minting a series, every lane is published at zero on startup so a dormant lane is distinguishable from an unwired one, and a registry failure is swallowed so counting can never change an authorization or credential outcome. This is a use rate, deliberately not a burndown gauge: `docs/organization-tenancy.md` records why none of the tenancy compatibility populations is drainable on the current write paths, and which lanes are intentionally left uninstrumented.

### Patch Changes

- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0

## 0.7.11

### Patch Changes

- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/contracts@1.4.0

## 0.7.10

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0

## 0.7.9

### Patch Changes

- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
  - @opengeni/contracts@1.2.0

## 0.7.8

### Patch Changes

- 31231dc: Expose bounded configured and effective sandbox rollout state for every API and worker workload revision.
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/contracts@1.1.0

## 0.7.7

### Patch Changes

- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1

## 0.7.6

### Patch Changes

- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0

## 0.7.5

### Patch Changes

- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0

## 0.7.4

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/contracts@0.49.0

## 0.7.3

### Patch Changes

- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0

## 0.7.2

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/contracts@0.47.0

## 0.7.1

### Patch Changes

- Updated dependencies [3d74340]
  - @opengeni/contracts@0.46.0

## 0.7.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/contracts@0.45.0

## 0.6.2

### Patch Changes

- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1

## 0.6.1

### Patch Changes

- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/contracts@0.44.0

## 0.6.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0

## 0.5.16

### Patch Changes

- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1

## 0.5.15

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0

## 0.5.14

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4

## 0.5.13

### Patch Changes

- 1385585: Bound active turn memory, make worker admission cgroup-aware, and replace paused-prompt queue pressure with eligible Temporal backlog and slot saturation metrics.
- Updated dependencies [dfcf698]
  - @opengeni/contracts@0.41.3

## 0.5.12

### Patch Changes

- e627d88: Keep known-cold sandbox views passive, fence delayed live-read invalidations across draining transitions, and expose bounded structural Channel-A failure diagnostics without leaking provider details.

## 0.5.11

### Patch Changes

- Updated dependencies [e2edfbc]
  - @opengeni/contracts@0.41.2

## 0.5.10

### Patch Changes

- 56f612b: Isolate read handles from process-capable handles, replace Modal's transport in place when its command-router URL rotates, rebuild the exact lease-fenced handle once for side-effect-free reads after a typed provider outage, and correlate handle recovery safely across API and reaper logs.

## 0.5.9

### Patch Changes

- 81a51ac: Settle abandoned turn workspace admissions only after the exact attempt's physical writers drain, while preserving eager cancellation holder release and late sandbox provisioning safety. Add privacy-preserving sandbox lease correlation keys to rendered lifecycle logs.

## 0.5.8

### Patch Changes

- Updated dependencies [2727236]
  - @opengeni/contracts@0.41.1

## 0.5.7

### Patch Changes

- Updated dependencies [bb9a346]
  - @opengeni/contracts@0.41.0

## 0.5.6

### Patch Changes

- Updated dependencies [fed43cf]
  - @opengeni/contracts@0.40.0

## 0.5.5

### Patch Changes

- Updated dependencies [200586a]
  - @opengeni/contracts@0.39.5

## 0.5.4

### Patch Changes

- Updated dependencies [70ced80]
  - @opengeni/contracts@0.39.4

## 0.5.3

### Patch Changes

- Updated dependencies [5d8bb99]
- Updated dependencies [34c5cdb]
  - @opengeni/contracts@0.39.3

## 0.5.2

### Patch Changes

- 78a1577: Separate expected sandbox path misses from actual provider-operation failures in metrics and alerts.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/contracts@0.39.2

## 0.5.1

### Patch Changes

- Updated dependencies [ce823ce]
  - @opengeni/contracts@0.39.1

## 0.5.0

### Minor Changes

- 33166b0: Export the canonical namespace and Grafana dashboard selectors used by the
  shared self-hostable Prometheus and Grafana distribution.

## 0.4.17

### Patch Changes

- Updated dependencies [6eb0b23]
  - @opengeni/contracts@0.39.0

## 0.4.16

### Patch Changes

- Updated dependencies [c0f8e40]
  - @opengeni/contracts@0.38.3

## 0.4.15

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2

## 0.4.14

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1

## 0.4.13

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/contracts@0.38.0

## 0.4.12

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0

## 0.4.11

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/contracts@0.36.1

## 0.4.10

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0

## 0.4.9

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0

## 0.4.8

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0

## 0.4.7

### Patch Changes

- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0

## 0.4.6

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0

## 0.4.5

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2

## 0.4.4

### Patch Changes

- Updated dependencies [9c4d73d]
  - @opengeni/contracts@0.31.1

## 0.4.3

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/contracts@0.31.0

## 0.4.2

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0

## 0.4.1

### Patch Changes

- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0

## 0.4.0

### Minor Changes

- 38ba6bc: Add bounded routed-sandbox provider operation observations and the fail-safe
  Prometheus observer used by API-direct and worker turn execution.

## 0.3.0

### Minor Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

## 0.2.1

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.
