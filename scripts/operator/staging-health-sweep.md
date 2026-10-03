# Fast staging reliability sweep

Run with Bun and authenticated kubectl access. This command does not create schedules or change workloads, sessions, or chart values.

```sh
bun scripts/operator/staging-health-sweep.ts --context opengeni-stg-neu-aks-admin --namespace opengeni --database-secret opengeni-migrations
```

The default output is JSON; add `--format text` for plain text. Exit 0 means no findings in the covered sources, 1 means findings, and 2 means at least one source/evidence gap (other findings remain in the result). A source gap must never be interpreted as healthy. JSON definitions record latency population/window and restart-history limitations. Session lists are capped at 100 but totals are uncapped.

Database reads require verified `BYPASSRLS` or superuser global coverage. The existing migration secret is an explicit operator-selected fallback, not a runtime default; prefer a dedicated global read-only diagnostic role. Every query runs in a read-only transaction with row-security fail-closed, a 5-second statement timeout and a 1-second lock timeout. Secret values travel only through pod stdin and never appear in argv, logs, or files. Without a selected secret or `OPENGENI_HEALTH_DATABASE_URL`, database checks report gaps. The chosen API pod must have Bun and network access to the database.

Flags: `--context`, `--namespace`, `--window-minutes` (default 30), `--baseline-minutes` (120, disjoint and preceding the current window), `--timeout-seconds` (20, maximum 60), `--database-secret`, `--database-secret-key`, `--db-pod` (deployment/opengeni-api), `--prometheus-namespace` (observability), `--prometheus-service` (opengeni-observability-prometheus), and `--format` (json/text). Database execution may be killed at the source deadline before all four queries complete, in which case all missing checks report gaps.

Queue findings distinguish runnable overdue work from terminal sessions and intentional paused, waiting, or predecessor-blocked queues. Recovery age uses the latest durable transition, not a heartbeat-updated row. Empty completion candidates exclude terminal sessions, revision-aware inherited pauses, waits, maintenance, and unflagged tool-only continuations. Explicit `emptyFinalReply` remains suspect even if tools ran; repeated candidates are triage evidence, not a claim that tool-only work failed. Historical/runtime versions lacking usable evidence may require source-specific investigation.

Latency is logical acceptance (`session_turns.created_at`) to stored `started_at` for turns started in the window. It is neither first-token latency nor per-attempt recovery latency; never-started turns are covered by queue checks. Zero latency samples produce null percentiles, not zero latency.

HTTP errors use reset-safe Prometheus increases with numerator/denominator counts (possibly fractional due to extrapolation). Missing total-request series is a gap. No traffic makes the comparison insufficient rather than a healthy zero error rate. Error alerting requires 20 current requests, three 5xx errors, at least 1% current error rate, twice baseline, and a one-percentage-point increase. Deleted pod restarts and older OOMs are not recoverable from current Pod objects; use retained telemetry for historical incident reconciliation.

Targeted verification:

```sh
bun test ./scripts/operator/staging-health-sweep.test.ts
```