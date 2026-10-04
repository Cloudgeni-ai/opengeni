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
| Eligible backlog / schedule-to-start / slots | Runnable work cannot start promptly. Check monitor freshness, Temporal queues, memory-safe worker slots and HPA desired/current/max replicas. Paused prompts and provider-capacity waits are not worker-eligible backlog. |
| TTFT / queue-to-first-byte | Responses start slowly. Compare queue, provider-dispatch and provider first-byte timings; phase durations overlap and must not be summed. Failed turns with no token are availability failures, not fast latency samples. |
| API 5xx / read latency | The control plane is degraded. Split by bounded route/status; inspect API memory, DB CPU/connections, append latency and retained logs before increasing API replicas. |
| OOM / restarts / memory near limit | A process died or is approaching its limit. Inspect pod last termination reason, working set versus limit, node pressure and the release revision. Capture logs first; coordinate mitigation with the reliability/capacity owner rather than repeatedly restarting. |
| Worker/HPA/node saturation | Autoscaling is at a ceiling or infrastructure is unhealthy. Check pending pods, node CPU/memory, requests/limits and autoscaler events. Extra replicas will not fix a DB or provider quota bottleneck. |
| Database CPU / connections / append latency | Postgres is saturated or unavailable. Inspect active connections, blocking queries and durable-write latency. Do not replay uncertain writes or raise connection pools blindly. |
| NATS / Temporal / scrape unhealthy | Delivery or orchestration is degraded, or its monitor is missing. Check dependency targets and pods. Postgres remains durable truth; replayable NATS delivery is not commit evidence. |
| Modal create failure / latency / capacity | Sandbox provisioning is failing, slow or nearing an independently confirmed plan limit. Inspect bounded category/stage, inventory freshness and concurrent provider usage. Exclude expected lease transitions; reconcile unknown create outcomes before retrying. |
| Provider failures / 429 / pool or quota | Model capacity or credentials are failing. Separate Azure OpenAI, Codex and Claude; check the affected model's deployment/quota or subscription pool. Missing quota telemetry is unknown, not spare capacity; never rotate credentials as an incident shortcut. |
| Credits / checkout / frontend errors | Funding, checkout or the browser journey is failing. Compare server checkout outcomes with the content-free browser beacon. Check Stripe availability, webhook processing and balance grants; do not retry a charge without its provider receipt. |
| Alert delivery failed / logs stale / cap reached | Monitoring itself has lost coverage. Check receiver failures and notification receipts, or Container Insights ingestion/DCR and workspace cap. Restore coverage before interpreting absent errors as healthy. |

## Evidence and operating rules

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