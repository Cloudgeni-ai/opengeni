---
"@opengeni/codex": patch
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Codex Apps keeps working when a workspace routes models through its organization's Codex accounts. The workspace's designated Apps account now loads, and its token refreshes persist, through the Apps designation itself instead of the model-routing pool; that authority still reaches only the designated account, owned by this workspace and its current owner. Turning Apps off (`DELETE /v1/workspaces/:workspaceId/codex/apps`) now works in every routing mode, so `apps.canDisable` is accurate.

Apps no longer posts an authorization card every time it sets up a turn. A card appears only when an Apps tool call needs one, at most once per turn, and an unusable designated account is reported with the new `tool.auth_needed` reason `designated_credential_unavailable` instead of `refresh_failed`. Clients should treat unknown reasons generically, as before.
