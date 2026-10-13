---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Secrets: every vault row opens again, and 1Password connections are manageable.

- Fixed vault, item and connection rows that only opened when their title or timestamp was clicked. A page-wide hit-area rule on the Secrets pages covered each row's full-width click target.
- Connect 1Password is a visible button on Secrets. The flow asks who can use the connection first (Only me, This workspace or the organization), links to 1Password's guide for creating a service account, and names plans in plain words.
- Settings › Secrets lists 1Password connections with their owner, linked vaults and any token or sync problem. A connection's page links more vaults, replaces the token in place (linked vaults keep working) and disconnects it (unlinks its vaults; nothing is deleted in 1Password). A vault's Replace token action now updates its connection instead of creating a second one.
- Vaults are grouped by who can use them; a vault linked from 1Password shows which account it comes from and links to it.
- New API routes `GET /connections/1password/service-accounts`, `PUT /connections/:connectionId/1password/token` and `DELETE /connections/:connectionId/1password`, with SDK methods `listOnePasswordConnections`, `replaceOnePasswordToken` and `disconnectOnePassword`.
