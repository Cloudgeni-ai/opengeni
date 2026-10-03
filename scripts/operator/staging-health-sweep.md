# Fast staging reliability sweep

Run with Bun and authenticated kubectl access. This command does not create schedules or change workloads, sessions, or chart values.

```sh
bun scripts/operator/staging-health-sweep.ts --context opengeni-stg-neu-aks-admin --namespace opengeni --database-secret opengeni-migrations
```

The default output is JSON schema `opengeni.staging-health-sweep.v2`; add `--format text` for plain text. Version 2 separates preliminary SQL age candidates from canonical ownership-confirmed triage candidates; version 1 age-only counts must not be treated as proven stranded work. Exit 0 means no findings in the covered sources, 1 means findings, and 2 means at least one source/evidence gap (other findings remain in the result). A source gap must never be interpreted as healthy. JSON definitions record latency population/window and restart-history limitations. Session lists are capped at 100 but totals are uncapped.

Database reads require verified `BYPASSRLS` or superuser global coverage. The existing migration secret is an explicit operator-selected fallback, not a runtime default; prefer a dedicated diagnostic role. Bulk queries run in read-only transactions with row-security fail-closed, a 5-second statement timeout and a 1-second lock timeout. Canonical ownership observations use the deployed `evaluateSessionControl` and control `peekSessionWork`, including its exact-attempt revalidation and Temporal workflow-run/activity inspector. These SELECT-only observers require `FOR SHARE`, which PostgreSQL forbids in a `READ ONLY` transaction; instead each observation runs in an **unconditionally rolled-back transaction**, with 3-second statement, 1-second lock, and 2-second metadata-RPC deadlines. No wake, recovery, signal or business writer is invoked. Ownership observations are capped at 20 targets and two database connections; omitted, failed, or unknown observations are explicit gaps. Secret values travel only through pod stdin and never appear in argv, logs, or files. Without a selected secret or `OPENGENI_HEALTH_DATABASE_URL`, database checks report gaps. The chosen API pod must have the deployed monorepo modules at `/app`, Bun, and network access to PostgreSQL and Temporal.

Flags: `--context`, `--namespace`, `--window-minutes` (default 30), `--baseline-minutes` (120, disjoint and preceding the current window), `--timeout-seconds` (20, maximum 60), `--database-secret`, `--database-secret-key`, `--db-pod` (deployment/opengeni-api), `--prometheus-namespace` (observability), `--prometheus-service` (opengeni-observability-prometheus), and `--format` (json/text). Database execution may be killed at the source deadline before all four queries complete, in which case all missing checks report gaps.

The queue population is sessions with durable `status=queued`, aged from the earliest queued turn or initial session creation. Historical queued-turn rows under nonqueued sessions are outside this population; they must not be labeled stranded from row age alone. Queue SQL counts (`sqlRunnableCandidates`) are preliminary age/control candidates. `actionable` counts canonical runnable or settled-owner triage candidates; a settled Temporal activity never proves physical writer quiescence or licenses recovery. Pending owners, terminal sessions, intentional pauses, input/capacity/approval waits, admission blocks and settlement waits are separately classified. Recovery age uses the latest durable transition, not a heartbeat-updated row, and receives the same canonical ownership check. Missing ownership evidence produces exit 2 even if other findings exist. Empty completion candidates exclude terminal sessions, revision-aware inherited pauses, waits, maintenance, and unflagged tool-only continuations. Explicit `emptyFinalReply` remains suspect even if tools ran; repeated candidates are triage evidence, not a claim that tool-only work failed. Historical/runtime versions lacking usable evidence may require source-specific investigation.

Latency is logical acceptance (`session_turns.created_at`) to the **first nonduplicate durable `turn.started` event's `created_at`**, for logical turns whose first event is in the window. It is neither first-token latency nor per-attempt recovery latency. Recovery/approval can overwrite the row's `started_at`; that timestamp is used only to select recent candidates and is never the measured start. First starts before the window are excluded and counted as `resumedFromBeforeWindow`. Missing first-start events are explicit gaps with no fallback to a later resume. Never-started turns are covered by queue checks. Zero latency samples produce null percentiles, not zero latency.

HTTP errors use reset-safe Prometheus increases with numerator/denominator counts (possibly fractional due to extrapolation). Missing total-request series is a gap. No traffic makes the comparison insufficient rather than a healthy zero error rate. Error alerting requires 20 current requests, three 5xx errors, at least 1% current error rate, twice baseline, and a one-percentage-point increase. Deleted pod restarts and older OOMs are not recoverable from current Pod objects; use retained telemetry for historical incident reconciliation.

Targeted verification:

```sh
bun test ./scripts/operator/staging-health-sweep.test.ts
```

## Recurring operator prerequisites

Tested warm-sandbox invocation (Bun 1.4.0, kubectl 1.34.1):

```sh
PATH=/workspace/bin:/usr/local/bin:/usr/bin:/bin KUBECONFIG=/workspace/kube/stg.yaml /usr/local/bin/bun /workspace/opengeni/scripts/operator/staging-health-sweep.ts --context opengeni-stg-neu-aks --namespace opengeni --database-secret opengeni-migrations --format json
```

A warm run reuses the checkout, binaries and mode-600 kubeconfig; no local dependency installation is required. On a cold sandbox, restore the reviewed repository head and binaries, then retrieve **staging only** AKS credentials using the attached Azure service principal: resource group `rg-opengeni-stg-neu`, cluster `opengeni-stg-neu-aks`. Store the kubeconfig mode 600 without printing it and use its actual context name; Azure-returned credentials here used `opengeni-stg-neu-aks`, not the default `-admin` alias.

Required access: namespace Pod reads, metrics-server reads, selected Secret read, API Pod exec, and Prometheus service proxy. The selected DB credential must pass global RLS coverage; the API image must expose the deployed `/app` modules and reach PostgreSQL and Temporal. Prometheus is `observability/opengeni-observability-prometheus:9090`, with live `opengeni-api` scrape targets and `opengeni_http_requests_total`. Failed prerequisites remain explicit gaps, never healthy results. The parent owns the native 30-minute cadence; this CLI creates no schedule, alerts, infrastructure or load traffic.