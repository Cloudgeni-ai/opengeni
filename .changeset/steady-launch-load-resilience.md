---
"@opengeni/events": patch
"@opengeni/worker-bundle": patch
---

Keep detached NATS subscription loops from rejecting the process: a poison message or throwing consumer is dropped and logged, and a subscription error such as a permissions violation ends only that subscription instead of reaching the API's fatal unhandled-rejection boundary. Long-lived NATS connections keep reconnecting through repeated auth errors. A freshly created sandbox that misses its command-readiness budget is terminated and replaced once after a jittered pause, and Codex/xAI capacity-wait wakes are spread by a bounded replay-safe jitter so a capacity reset no longer resumes every waiting turn at once.
