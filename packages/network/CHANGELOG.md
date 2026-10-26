# @opengeni/network

## 5.3.1

### Minor Changes

- 4c6bf32: An organization's Azure OpenAI connection can now sign in with Microsoft Entra ID instead of an API key, so Azure resources that turn key authentication off can run agent turns. Admins choose the sign-in method when connecting: an API key (unchanged), the organization's own Entra app registration with a client secret, or, when the operator sets `OPENGENI_AZURE_OPENAI_DEPLOYMENT_IDENTITY_ENABLED=true` and configures the standard `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` or `AZURE_CLIENT_SECRET` variables, the deployment's own workload identity. Tokens for the `https://cognitiveservices.azure.com/.default` scope are cached per credential and renewed before they expire. The upsert request accepts `authentication` in place of `apiKey`, connection responses report `authMethod`, and the client config reports `azureOpenAIDeploymentIdentity`. `@opengeni/network/azure-entra` exports the shared token source.

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

### Patch Changes

- d1de8b4: Honor explicit provider-dispatch catalog preparation even when all MCP servers
  are already connected. Keep eager schemas available before the first request,
  and join the same catalog completion fence before tool execution and cleanup.
  Use the shared transport's dispatch notification after admission and transport
  setup on both native subscription and generic model routes.
  Compile a tool's input and output validators together on its first call, before
  authorization or execution, instead of compiling every unused tool at startup.
  Malformed schemas now fail that tool's call rather than catalog preparation.

## 4.2.0

## 4.1.3

## 4.1.1

## 4.0.4

### Patch Changes

- 35dcfa0: Use Azure's API-key header for configured API-key credentials on HTTP and Responses WebSocket connections, while preserving Entra bearer authentication and explicit header overrides. Treat a redirected WebSocket upgrade as a refusal and use the existing turn-scoped HTTP fallback without following credential-bearing redirects.
- b1b51e2: Report HTTP response-reader cancellation separately from transport failure. A consumer that stops reading after a successful model terminal event no longer produces a false transport-failure metric.
- 1d24639: Reserve persistent Responses sockets for explicitly scoped conversation requests so title side requests cannot displace a warmed main connection or continuation chain. Add immutable request-receipt snapshots of local dispatch/socket timing and allowlisted response-scoped server timing, without changing model request content, prewarming, retries, or custody.
- a34aebb: Responses WebSocket requests continue the previous response on the same connection: when a request extends the last completed response exactly, it sends `previous_response_id` and only the new input items, and falls back to the full request otherwise or when the provider no longer holds that response. The transport now serves the OpenAI API (`/v1/responses`) and Azure OpenAI's v1 API (`/openai/v1/responses`) as well as the Codex subscription, with one connection per conversation (`OPENGENI_OPENAI_RESPONSES_WEBSOCKET_ENABLED`, default on). Other OpenAI-compatible hosts stay on HTTP. Each request's transport label and the model-request phase metrics say whether the input was full or incremental.

  Share lifecycle and failure policy in the network package. Use the JavaScript WebSocket implementation to release sent buffers, retain only continuation fingerprints, coalesce concurrent handshakes, and retire idle connections when credentials change. The existing durable model-step retry budget owns dropped responses; its final retry uses HTTP, with no additional retry budget or timer-based cooldown. HTTP remains selected through turn recovery and subsequent successful steps, but a new turn tries the socket again. Definitive continuation refusal settles and re-admits request custody before a full-input resend. Transport diagnostics distinguish first-request cache behavior and final-prefix startup overlap; no speculative model prewarm is sent.

## 3.4.0

## 3.3.0

## 3.2.2

## 3.1.2

## 3.0.0

## 2.0.1

## 2.0.0

## 1.4.4

## 1.4.3

## 1.4.2

## 1.4.1

## 1.4.0

## 1.3.0

## 1.2.0

## 1.1.0

## 1.0.2

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.3.2

### Patch Changes

- 3cc26b5: Identify the default pinned HTTP client with a User-Agent, preserve caller overrides, and show retryable MCP sign-in discovery failures in connection setup.

## 0.3.1

### Patch Changes

- 52cf486: Use protected-resource metadata prefix locations instead of guessing a metadata URL beneath the protected API route. Preserve explicitly advertised URLs and fail-closed metadata handling.
- 92cdc31: Follow the standard MCP authorization-server metadata discovery order so protected guessed routes cannot prevent discovery of valid OpenID metadata.

## 0.3.0

### Minor Changes

- 876396d: Support safe same-origin legacy MCP OAuth discovery when RFC 9728 Protected Resource Metadata is absent, and expose shared runtime/catalog discovery classifications.

## 0.2.3

### Patch Changes

- 16387c3: Keep ordinary MCP connections pinned to the complete vetted DNS answer under Bun and prefer IPv4 when a public dual-stack destination is available.

## 0.2.2

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.

## 0.2.1

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.

## 0.2.0

### Minor Changes

- 664c1d8: Bound MCP OAuth setup with an absolute server deadline, abort stalled response streams, and preserve safe stage-specific API error details in SDK clients.

## 0.1.2

### Patch Changes

- 4976e1c: Fix DNS-pinned OAuth response streaming under Bun and expose X as a built-in workspace social capability.

## 0.1.1

### Patch Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.
