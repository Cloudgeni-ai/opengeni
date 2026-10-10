---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Turning Opengeni credits off in a workspace (`allowCreditModels: false`) now stops every credit meter, not only credit-billed models. Paid web search and web fetch are refused with a message that names the switch, knowledge search falls back to keyword results (`fallbackReason: "credits_disabled"`; `mode: "vector"` returns 403), and paid knowledge indexing waits without calling the embedding provider and resumes when credits are turned back on. The model catalog reports a credit model blocked only by the switch with the new availability reason `credits_disabled`, which the React picker labels "Opengeni credits off". Both enum values are additive; clients that do not know them keep their existing fallback.
