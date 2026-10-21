---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/worker-bundle": minor
"@opengeni/decisions": minor
"@opengeni/jev": minor
---

Improve deferred tool discovery with field-aware retrieval, best-match-first schema
loading and compact alternatives, an optional generic decision model for ambiguous
queries, exact-name loading,
and a paginated tool-group directory. Freeze disclosures in append-only history and
keep the first-request tool block stable. Preserve native Responses search and direct
function loading. Add retrieval and live generic discovery evaluations.

Introduce a shared typed decision-model category for tool discovery and code search,
with the existing Jev client and OpenAI/OpenRouter Decisions adapters. Use explicit
deployment credentials, preserve legacy code-search configuration, and retain
provider usage provenance without customer-credit debits. Code-search stats, usage
events and metrics use decision rather than Jev names.
