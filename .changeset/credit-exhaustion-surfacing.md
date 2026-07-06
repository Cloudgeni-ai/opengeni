---
"@opengeni/react": minor
---

Credit exhaustion renders as a first-class failure with a top-up CTA (was: silent idle). A budget-exhausted `turn.completed` (`segmentLimit: "budget_exhausted"` / `detail: "insufficient OpenGeni credits"`) now projects as a failed turn-end plus a failed notice instead of a clean completed turn, and `turn.failed` credit errors collapse to one canonical sentence via `humanizeFailureReason`. New exports: `isCreditExhaustion`, `creditExhaustedFromEvents`, and `CREDIT_EXHAUSTION_MESSAGE`. The web console (unversioned app) rides along: a credit-specific banner with an "Add credits" link to organization settings — shown also on idle sessions whose last turn died of budget exhaustion — replacing the "send a message to revive" copy that cannot work without credits.
