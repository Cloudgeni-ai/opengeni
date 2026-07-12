---
"@opengeni/runtime": patch
---

Record a provider-reported `cached_tokens: 0` as 0 in model-call usage telemetry instead of null. The previous >0-only filter made "the provider cached nothing" indistinguishable from "no telemetry returned" — which is exactly how 10k+ genuinely-uncached Azure gpt-5.6 calls masqueraded as a telemetry gap during the 2026-07-12 incident forensics. Absent detail objects still record null (unknown). Pricing is unaffected (null and 0 both bill the uncached rate); dashboards gain an honest zero.
