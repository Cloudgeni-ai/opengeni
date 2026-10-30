# @opengeni/decisions

## 6.0.2

### Patch Changes

- 86c3295: Decision models (tool-search selection and code search) can run on an Azure OpenAI resource that has key sign-in turned off. Set `OPENGENI_DECISION_MODEL_AUTH=deployment_identity` with provider `openai`, the deployment name and the resource's v1 base URL, and requests are signed with a cached Microsoft Entra token for the deployment's own identity. `createHttpDecisionModel` accepts an access-token function in place of a static key, and drops a token the provider rejects.
- 7148073: Tool search retries its decision model once, after a 250 ms pause, when the provider answers with a rate limit, a server error or an expired sign-in, or the connection drops. Both attempts stay inside the search's 5-second selection deadline, so a brief provider hiccup no longer turns a search into a keyword-only result. Invalid answers, billing and permission refusals are not retried. A dropped connection to a decision provider now carries the error code `request_failed`.

## 5.5.1

## 5.4.2

## 5.3.1

## 5.2.1

## 5.1.2

## 5.0.2

## 4.8.0

## 4.7.2

## 4.7.1

## 4.7.0

## 4.6.1

## 4.5.0

## 4.4.1

## 4.3.1

### Minor Changes

- 5e32e0f: Improve deferred tool discovery with field-aware retrieval, best-match-first schema
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
