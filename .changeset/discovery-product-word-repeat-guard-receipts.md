---
"@opengeni/capabilities": patch
"@opengeni/runtime": patch
---

A query names a multi-word integration by the word of its name that is also its own domain's word ("Dynamics 365" names Microsoft Dynamics at dynamics.com); written with a capital mid-sentence it names it distinctively, so tool search shows its Connect card. When a search names one integration distinctively, integrations named only by ordinary words of the same request ("close date" for Close) no longer stop the card. The repeated-call guard now compares command results without the per-call metadata the runtime adds (output receipt ids, chunk ids, wall times), so a command that prints the same output every time is recognised as repeating.
