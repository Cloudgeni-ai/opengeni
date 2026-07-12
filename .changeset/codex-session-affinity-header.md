---
"@opengeni/codex": patch
---

Send a stable `session_id` header on every codex-subscription request. This is the backend's sticky prompt-cache-routing key: measured with byte-identical ~99k-token gpt-5.6-sol requests on one idle account, repeat requests WITHOUT the header hit the prompt cache only ~50% of the time (a per-request routing lottery across cache shards — matching the production fleet's 48.6% token-weighted hit rate), while WITH a stable session_id 10/10 requests hit at the 99.0% ceiling. Codex CLI always sends this header (its own last-3-days token-weighted rate on the same account is 94%); `prompt_cache_key` in the body only influences routing and does not pin it. The worker supplies the OpenGeni sessionId — the same value already used for `prompt_cache_key` — so routing and cache key agree, and the compaction summarizer (same request context) rides the same warm shard. Requests without a session context are unchanged.
