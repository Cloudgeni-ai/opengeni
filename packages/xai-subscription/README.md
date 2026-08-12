# `@opengeni/xai-subscription`

Pure protocol helpers for OpenGeni's workspace-scoped SuperGrok/xAI connected-subscription rail.

The package owns:

- xAI OAuth 2.0 device-code login, refresh, and verified OIDC user-info lookup;
- per-request credential context and the authenticated Responses transport;
- provider request normalization for encrypted reasoning and hosted search tools;
- bounded quota and live model-metadata reads from the Grok CLI proxy; and
- direct xAI image/video generation helpers.

It deliberately has no database dependency. Workspace ownership, encrypted persistence, account selection, allocator state, leases, and durable request receipts remain in OpenGeni's DB/worker layers.