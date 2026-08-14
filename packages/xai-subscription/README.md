# `@opengeni/xai-subscription`

Pure protocol helpers for OpenGeni's explicit `workspace | user` SuperGrok/xAI
connected-subscription rail. Workspace scope is the default shared path; tenant
authority and persistence remain outside this package.

The package owns:

- xAI OAuth 2.0 device-code login, refresh, and verified OIDC user-info lookup;
- per-request credential context and the authenticated Responses transport;
- provider request normalization for encrypted reasoning and hosted search tools;
- bounded quota reads and credential validation against the Grok CLI proxy; and
- direct xAI image/video generation helpers.

It deliberately has no database dependency. Workspace/user authority,
encrypted persistence, account selection, allocator state, leases, and durable
request receipts remain in OpenGeni's DB/worker layers.

See [`docs/supergrok-subscription.md`](../../docs/supergrok-subscription.md) for
the canonical authority, rotation, and durable-capacity contract.
