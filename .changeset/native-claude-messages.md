---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Support native Claude Messages with separate encrypted Anthropic API-key and Claude subscription setup-token connections, workspace access policies, streaming tools and thinking, prompt caching and usage accounting. Add connection UI and payment-source labels. Migration 0544 expands organization connection kinds and lifecycle validation.

Pin the Claude subscription client identity headers, persist account/device metadata with encrypted credentials, and add request-scoped attribution. Existing token-only connections require replacement with identity metadata. The captured billing checksum remains unverified and is not replayed.

Preserve Claude session identity across worker turns and recovery while keeping prompt lineage scoped to each run.

Admit organization Claude models through session creation and lock their correct connection kind. Preserve Claude provider labels in the client catalog. Project initial system/developer instructions into Anthropic’s top-level system field so full agent sessions with skill instructions execute successfully.

Polish Claude setup with local settings import, full-page token renewal, named model choices, provider marks, accurate subscription payment labels, and workspace discovery of organization-owned connections.

Support workspace-owned Claude credentials, model generations, access controls and setup/account screens alongside organization connections. Migration 0545 expands workspace custom-model provider kinds. Gate Claude subscriptions behind OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED (default off), leaving Anthropic API keys and other providers unchanged.
