---
"@opengeni/worker-bundle": patch
---

The turn retry alert no longer fires on short model-provider outages, which the per-provider model-call failure alert already covers. Every turn attempt that ends recovering now also counts in `opengeni_turn_recoveries_total{cause}`, with a closed cause chosen where the recovery is requested: `provider`, `sandbox`, `tool`, `worker`, `database`, `control` or `other`. `OpenGeniTurnRecoveryRatioHigh` counts every cause except `provider`. `opengeni_turns_total` is unchanged.
