---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/subscriptions": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/worker-bundle": minor
---

An organization or workspace can add several Anthropic API keys to its Claude account pool, each with its own label (Add Claude account → API key, or `connectClaudeSubscriptionApiKey` / `connectOrganizationClaudeSubscriptionApiKey` in the SDK). A key is checked by listing models, never by running one, and its account is the key's Anthropic organization. Placement uses a key only when no Claude plan account has room, keeps each session on its key so the prompt cache survives, and moves the session to another account when Anthropic reports the key's credit balance is too low; the key is tried again an hour later. Rate limits follow the pool's ordinary handling. The account list shows each key as API credits or Out of credits and never shows the key. The single-key Anthropic API connection is unchanged.
