---
"@opengeni/config": patch
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/api-router": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add explicit anonymous OpenAI-compatible model providers with credential-free
transport, external billing attribution, catalog readiness, and an External
picker rail while preserving older client parsing by classifying the route from
existing billing metadata instead of widening closed client enums. Anonymous
providers reject all configured request headers and query parameters, and the
runtime strips credential-like headers as a defense in depth. Document the
temporary OpenCode Zen free-preview configuration.
Generic Chat Completions routes also reject an `unknown` finish reason before
accepting a terminal response, so the same accepted turn recovers from durable
history without executing tools from ambiguous output.