---
"@opengeni/events": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep detached NATS subscription loops from rejecting the process: a poison message or throwing consumer is dropped and logged, and a subscription error such as a permissions violation ends only that subscription instead of reaching the API's fatal unhandled-rejection boundary. A session or workspace-control SSE stream whose live subscription ends fails retryably so the client replays from Postgres, and the auth-callout, Codemode request, and agent-event responders resubscribe with bounded backoff; every unexpected end is counted in `opengeni_nats_subscription_terminations_total` and alerts. Long-lived NATS connections keep reconnecting through repeated auth errors. A freshly created sandbox that misses its command-readiness budget is terminated and replaced at most once per turn attempt after a jittered pause, with outcomes in `opengeni_sandbox_readiness_replacements_total`, and Codex/xAI capacity-wait wakes are spread by a bounded replay-safe jitter so a capacity reset no longer resumes every waiting turn at once.
