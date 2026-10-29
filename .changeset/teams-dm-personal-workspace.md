---
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

A Microsoft Teams 1:1 chat with the bot now lands in the sender's own Personal workspace, as a Slack bot DM already does, while Personal workspaces are on and they can start chats there. Otherwise it stays in the installation's shared workspace. The Personal workspace comes from the sender's active organization membership, never from Teams. Channels and group chats stay in the shared workspace. An existing 1:1 chat stays where it is; the next message starts a fresh chat in the Personal workspace, and turning Personal workspaces off returns to the earlier one. The bot's installation and the person's Teams link stay in the shared workspace, so losing access there still stops the chat. Migration 1097 adds `teams_bot_routes.session_workspace_id`.
