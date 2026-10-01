---
"@opengeni/sdk": patch
---

Allow isolated embedded users to attach the host's per-session MCP servers with the default non-admin conversation permissions. Add `memberPermissions` to the chat facade and standalone workspace resolver to replace initial onboarding permissions without modifying existing or revoked memberships.

Keep resolving existing workspace addresses when permission changes conflict with earlier keyed onboarding, without retrying or replacing a cancelled grant. Existing users need an explicit membership update to gain new permissions.