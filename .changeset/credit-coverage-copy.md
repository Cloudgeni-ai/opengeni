---
"@opengeni/react": patch
---

Credit refusals now say that the remaining credit does not cover the model, instead of implying the organization has no credit. Promotional credit can cover some models while another model has none left, so a 402 on Send and a turn that stops with `segmentLimit: "budget_exhausted"` both tell the person to choose a model their credits cover or add credits. The model picker's hint for an uncovered credits-billed model reads "Not covered by your credits" instead of "Needs credits". Message keys and exports are unchanged.
