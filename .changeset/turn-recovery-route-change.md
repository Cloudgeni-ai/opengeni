---
"@opengeni/worker-bundle": patch
---

The turn retry alert no longer fires when agents deliberately move their active sandbox mid-turn, for example to work on a connected machine and back. Such a swap or detach continues the turn on its new route in a fresh attempt by design; it now counts in `opengeni_turn_recoveries_total` as `cause="route_change"` instead of `sandbox`, and `OpenGeniTurnRecoveryRatioHigh` excludes it alongside `provider`. A home backend that still needs recovery remains `sandbox`.
