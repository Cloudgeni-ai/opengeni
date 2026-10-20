---
"@opengeni/runtime": patch
"@opengeni/agent-proto": patch
---

Use prefetched receiver-issued monotonic delivery tokens for Connected Machine reply recovery and streamed command deadlines, without an extra round trip on warm calls. Machine clock skew and corrections no longer reject valid control requests or poison replay admission. Expired and conflicting deliveries return prompt, non-retryable errors preserving uncertain prior outcomes. Mixed protocol versions retain conservative one-shot delivery.
