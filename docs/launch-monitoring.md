# Launch monitoring: first actions

Open **Grafana → Launch**, choose the environment, and use the last 15 minutes.
Read the overview first: probe freshness, first-turn success, failures, eligible
backlog, first response, API errors and memory. Expand the matching subsystem
only when a headline is unhealthy. **No data, stale telemetry and no traffic
are not green.** Use the environment's delivery record for the dashboard and
alert-channel links; staging is a production rehearsal, not production evidence.

## Alert → first action

| Alert family / signal | Meaning and first action |
| --- | --- |
| Synthetic failed / stale | Signup, authentication, first message or reply is broken, or the probe stopped. Read its failing stage and last success; check the live model catalog, trial balance and scheduler. A successful `/healthz` does not prove a turn works. |
| First-turn success / turn failure ratio | New users or durable turns are failing. Split by failure class/provider and compare the first-response availability signal; distinguish expected user cancellation from infrastructure failures. |
| Turn retries (`OpenGeniTurnRecoveryRatioHigh`) | Many turns are retrying automatically for a reason other than the model provider. Split `opengeni_turn_recoveries_total` by `cause`: `sandbox` (home backend recovery, lease or deadline transitions, commands that never started), `tool` (MCP transport or service unavailable), `worker` (shutdown or death), `database` (settlement could not be written), `control` (admission holds) or `other`. Provider outages, rate limits and subscription capacity count as `provider`, are excluded here and alert per model route as `OpenGeniModelCallFailureRatioHigh`. A swap or detach that moves the active sandbox mid-turn continues the turn on its new route by design; it counts as `route_change` and is excluded too. |
| Ready prompts waiting (`OpenGeniTurnReadyPromptWaiting`, `…Critical`) / eligible backlog / slots | A prompt that nothing in its session holds back has waited too long to start: `opengeni_turns_queued_oldest_age_seconds{hold="ready"}`, refreshed every reaper period (30 s by default). Prompts queued behind a running turn in their own chat, Paused, waiting for provider capacity or for a human are excluded by design; that is normal serialization and never alerts. If ready age is old while `opengeni_turn_eligible_backlog` is 0, check control-queue pollers and retried or timed-out control activities in Temporal. If the eligible backlog is up too, check monitor freshness, memory-safe worker slots and HPA desired/current/max replicas. Reserved slots include open polls; use `opengeni_turn_slot_saturation_ratio` for capacity. The cumulative acceptance-to-start milestone (`opengeni_turn_startup_milestone_duration_seconds{milestone="queue"}`) stays on the Turn Startup dashboard but does not alert. |
| Turn preparation / first byte (`OpenGeniTurnStartupProviderDispatchP95High`, `…Critical`, `OpenGeniTurnStartupFirstByteP95High`) / provider TTFT regression | These use `opengeni_turn_startup_since_attempt_start_seconds`: time from the start of the turn attempt that reached the milestone, so they exclude time behind an earlier turn, subscription capacity waits and recovery gaps. Slow provider dispatch is Opengeni preparation: find the slow phase in `opengeni_turn_startup_phase_duration_seconds` (claim, credentials, `sandbox_establish`, tool connects, history) and split per-request overhead with `opengeni_model_request_pre_dispatch_stage_seconds` before investigating admission, DB, credentials or transport. Slow first byte with normal dispatch is provider time to first token. `OpenGeniModelProviderTtftRegression` measures provider slowdown after dispatch against the provider's own 24h baseline. Its `signal` label says what it judged. `headers` is time to response headers, or to the first provider event on a persistent socket, for providers that report it: request shape barely moves it, so a regression there is the provider. `first_content` is time to the first streamed reasoning or answer delta, for providers without that report: it also grows with context size and reasoning length, so before steering users away check on Streaming Health whether a few long sessions with large contexts dominate the window. Absolute TTFT on reasoning models is legitimately long and does not alert. Phase durations overlap and must not be summed; histogram quantiles must not be subtracted to estimate preparation time. Failed turns with no token are availability failures, not fast latency samples. |
| Per-request pre-dispatch p95 (`OpenGeniModelRequestPreDispatchP95High`) | Opengeni delays each model request before the provider sees it. Split it with `opengeni_model_request_pre_dispatch_stage_seconds{stage}`: its stages are exclusive and add up to the request's pre-dispatch time, so the largest one is the cause. `settlement_wait` is the previous response's durable settlement; `admission` the per-call history reconcile and run/credit checks; `request_build` SDK serialization and request policy; `credential` the provider credential read; `dispatch_checkpoint` the durable history and route checkpoint; `request_audit` the durable request-start event; `provider_admission` the provider's durable one-shot reservation; `transport` residency, wire capture and the connection. When the database stages rise together, Postgres is saturated or session rows are lock-contended: check Postgres CPU, lock waits (`tuple`, `transactionid`) and idle-in-transaction sessions before the worker. When only `request_build` or `transport` rises, check turn-worker CPU and event-loop lag. |
| API route refusals / missing permission / handoff attach refused | Users are being refused (401/403/409/422) on one route far above its own baseline, or a route refuses most of its traffic. The route-refusal alert uses classified rejections and excludes only the typed `agent_attempt_caller_stale` refusal for an ended attempt, plus unauthenticated organization MCP discovery. Raw HTTP and rejection counters still include these denials; malformed, revoked, missing-permission and unclassified refusals remain actionable, including on Codemode routes. Open **Capabilities, browser & handoffs**, then the API `HTTP request completed` logs for that route: `rejectionCode` is the public error code, `rejectionReason` names the missing permission (`permission:stream:view`), domain code, or Connected Machine control failure, and `rejectionFingerprint` groups identical refusals (resolve it with `bun run scripts/resolve-rejection-fingerprint.ts`). Fix the grant or the client that offers an action the user cannot take; do not mute the route. |
| Browser/computer operations, handoffs, connect, OAuth callbacks, agent tools, Connected Machines | A product capability is failing for users: Browser/Computer operations by `reason`, human handoffs expiring unanswered, Connect attempts or provider OAuth callbacks failing by `provider`/`stage`/`reason`, agent tool families mostly erroring, Connected Machines refused at connect, or attached browsers unreachable. Split the named metric by its bounded labels (see `docs/deployment.md` product-failure metrics) before touching providers or credentials. |
| API 5xx / read latency | The control plane is degraded. Split by bounded route/status; inspect API memory, DB CPU/connections, append latency and retained logs before increasing API replicas. |
| OOM / restarts / memory near limit | A process died or is approaching its limit. Inspect pod last termination reason, working set versus limit, node pressure and the release revision. Capture logs first; coordinate mitigation with the reliability/capacity owner rather than repeatedly restarting. |
| Worker/HPA/node saturation | Autoscaling is at a ceiling or infrastructure is unhealthy. Check pending pods, node CPU/memory, requests/limits and autoscaler events. Extra replicas will not fix a DB or provider quota bottleneck. |
| Database CPU / connections / append latency | Postgres is saturated or unavailable. Inspect active connections, blocking queries and durable-write latency. Do not replay uncertain writes or raise connection pools blindly. |
| NATS / Temporal / scrape unhealthy | Delivery or orchestration is degraded, or its monitor is missing. Check dependency targets and pods. Postgres remains durable truth; replayable NATS delivery is not commit evidence. |
| Modal create failure / latency / capacity | Sandbox provisioning is failing, slow or nearing an independently confirmed plan limit. Inspect bounded category/stage, inventory freshness and concurrent provider usage. Exclude expected lease transitions; reconcile unknown create outcomes before retrying. |
| Sandbox drain stuck / drain snapshot failing | An idle sandbox cannot save its `/workspace` and shut down, so files changed since its last good snapshot are at risk when the provider ends the box at its lifetime limit. Find the sandbox group in the reaper's "persistWorkspace failed" warnings, then check its `/workspace` size in `opengeni_sandbox_workspace_snapshot_bytes` and `_files` (`outcome="failed"`, measured once per failed snapshot, without the manifest's ephemeral paths; successful Modal snapshots carry no size, so `outcome="captured"` comes from portable archives) and the provider snapshot timeout settings. Drain snapshots back off after each failure (30 s doubling to 10 min), so do not force repeated retries; never terminate the box by hand before its workspace is saved. On Modal, after three failures over at least 15 minutes (or one near the box's lifetime limit) the drain saves without rebuildable folders, and stops the box itself if that save fails or cannot be stored after an hour of failures or near the lifetime limit, or if near that limit it does not finish within the wait or no reduced save is possible (`opengeni_sandbox_drain_capture_fallback_total` by `outcome`; `abandoned` means files changed since the last save were not kept, and the chat shows a notice). |
| Provider failures / 429 / pool or quota | Model capacity or credentials are failing. Separate Azure OpenAI, Codex and Claude; check the affected model's deployment/quota or subscription pool. Missing quota telemetry is unknown, not spare capacity; never rotate credentials as an incident shortcut. |
| Credits / checkout / frontend errors | Funding, checkout or the browser journey is failing. Compare server checkout outcomes with the content-free browser beacon. Check Stripe availability, webhook processing and balance grants; do not retry a charge without its provider receipt. |
| Alert delivery failed / logs stale / cap reached | Monitoring itself has lost coverage. Check receiver failures and notification receipts, or Container Insights ingestion/DCR and workspace cap. Restore coverage before interpreting absent errors as healthy. |

## Evidence and operating rules

- Total MCP tool duration and retained Browser/Computer-session inventory are
  diagnostics, not warning conditions. Successful commands, connector operations
  and explicit waits may legitimately take a long time; total duration cannot
  distinguish requested work from service overhead. Retained interactions may
  deliberately keep a sandbox warm and do not prove a session is abandoned.
  Runtime Failures duration panels and
  `opengeni:sandbox_leases_interaction_only:fresh_max` remain available for
  investigation and cost review. Failure, uncertain-outcome, stuck-work and
  failed-drain alerts remain active. Do not terminate a session solely to clear
  an idle-inventory metric.
- Warning alerts need sustained, traffic-gated evidence; critical/page alerts
  use the configured urgent route. Group related symptoms by environment;
  keep repeat notifications bounded. Do not silence a real unresolved incident
  just to make the dashboard green.
- Verify delivery with a uniquely labelled test through the **actual alert
  route** and an observed message in the channel, then resolve the test.
  Receiver configuration or a direct Slack post alone is not delivery proof.
- Run signup-to-reply probes every few minutes with fresh sessions and
  synthetic classification; require reply content, not merely idle state.
  Record stage coverage, last success, cadence, failure and recovery. An
  API-key-only model canary does not cover signup or browser authentication.
- Retained production logs must be queried back from their configured sink.
  Check retention, scope, cap and ingestion freshness. Browser beacons contain
  closed kinds/actions, route patterns and bundle revision, **not** raw messages
  or stacks; counts are a bounded lower bound, not complete exception capture.
- Production changes use the reviewed ops repository and Helm-values/workflow
  path. Never apply a locally rendered chart to production. Record exact
  source/deploy revisions, rollback route and post-apply readback.

Configuration and metric semantics: [deployment](deployment.md#observability),
[application observability](application-observability.md),
[Codex rotation](codex-subscription-rotation.md). Thresholds, receivers and
environment-specific dashboards are owned by the deployed ops values/rules;
the delivery record must disclose any unsupported or stale signal.