# @opengeni/network

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
