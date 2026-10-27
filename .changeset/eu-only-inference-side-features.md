---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

EU-only inference covers side features. Web search, image and video
generation, live voice, transcription, Knowledge embeddings and decision
models each have residency records; under EU only routes with an EU record
run, nothing falls back outside the EU, and switched-off features report
`region_restricted` (shown as "Not supported in EU"). Operators declare EU
routes with `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON`, and usage events record
where each call ran.
