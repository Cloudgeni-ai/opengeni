# @opengeni/decisions

## 6.22.0

### Patch Changes

- Updated dependencies [d50092b]
  - @opengeni/contracts@6.22.0

## 6.21.0

### Patch Changes

- Updated dependencies [7d0d52b]
- Updated dependencies [ef4c334]
- Updated dependencies [ce864c0]
- Updated dependencies [6ac2cd4]
  - @opengeni/contracts@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/contracts@6.20.1

## 6.20.0

### Patch Changes

- Updated dependencies [ae3972e]
- Updated dependencies [e37485b]
- Updated dependencies [9c17a87]
  - @opengeni/contracts@6.20.0

## 6.19.0

### Patch Changes

- Updated dependencies [a85adef]
  - @opengeni/contracts@6.19.0

## 6.18.0

### Patch Changes

- Updated dependencies [f313a0e]
- Updated dependencies [6813960]
- Updated dependencies [9188c1d]
- Updated dependencies [3105a8b]
- Updated dependencies [a16189c]
- Updated dependencies [89cf4ba]
  - @opengeni/contracts@6.18.0

## 6.17.0

### Patch Changes

- Updated dependencies [8073ab6]
- Updated dependencies [43aa19d]
- Updated dependencies [b1b69fc]
- Updated dependencies [deccb54]
- Updated dependencies [668c5ed]
- Updated dependencies [e3cb3c1]
  - @opengeni/contracts@6.17.0

## 6.16.0

### Patch Changes

- Updated dependencies [fb19875]
- Updated dependencies [54dc5da]
  - @opengeni/contracts@6.16.0

## 6.15.0

### Patch Changes

- Updated dependencies [708848c]
- Updated dependencies [5525e63]
- Updated dependencies [60d067d]
- Updated dependencies [da60317]
- Updated dependencies [f92ff08]
- Updated dependencies [060c983]
- Updated dependencies [dfeab20]
- Updated dependencies [9885d37]
- Updated dependencies [f22647a]
- Updated dependencies [850b4d5]
  - @opengeni/contracts@6.15.0

## 6.14.0

### Patch Changes

- Updated dependencies [c976c87]
- Updated dependencies [6ae0528]
- Updated dependencies [3b853ca]
- Updated dependencies [dd11dad]
- Updated dependencies [91320a4]
- Updated dependencies [c472500]
  - @opengeni/contracts@6.14.0

## 6.13.0

### Patch Changes

- Updated dependencies [1c7aa2a]
  - @opengeni/contracts@6.13.0

## 6.12.0

### Patch Changes

- c0b9f88: Add workspace-scoped stateless typed decisions with SDK `decide`. Reuse the
  deployment's configured decision model, chat-completions authority, usage settlement
  and residency checks. Calls are deployment-funded, independent of customer agent
  allowances, with optional tenant-label attribution and off-path usage receipts.
  Preserve typed refusals and reported, estimated and unknown provider costs.
- Updated dependencies [64fd53f]
- Updated dependencies [281af3a]
- Updated dependencies [e9222e0]
- Updated dependencies [8cc1ddd]
- Updated dependencies [3929153]
- Updated dependencies [2e1e9c6]
- Updated dependencies [2e749ad]
- Updated dependencies [fcdf7de]
- Updated dependencies [bee1e4c]
- Updated dependencies [c0b9f88]
- Updated dependencies [00dd24b]
  - @opengeni/contracts@6.12.0

## 6.11.0

## 6.10.0

## 6.9.0

## 6.8.0

## 6.7.0

## 6.6.0

## 6.5.1

## 6.4.0

## 6.3.1

## 6.2.1

## 6.1.1

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
