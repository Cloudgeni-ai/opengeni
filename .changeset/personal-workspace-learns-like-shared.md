---
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/react": minor
---

A Personal workspace now learns and keeps files like a shared workspace. Its workspace chats, scheduled tasks and Site guest chats save Knowledge, Skills and instructions to the Personal workspace's own Workspace layer under its modes, and its files and Sites follow the chat's audience. Only me chats still learn for their person. Nobody but the owner can be in a Personal workspace, so its Workspace layer stays private to them; organization admins, other members and other workspaces still cannot reach it. As in a shared workspace, a workspace chat there doesn't read the owner's Personal Knowledge or Only me files, and the files it makes are Workspace files; existing workspace chats and schedules there no longer read the owner's earlier Personal Knowledge or Only me files, and a schedule there takes Only me files only for an Only me target chat. Migration 1095 copies the owner's Personal learning modes, and their chat and task overrides from that workspace, to its Workspace layer when it has none, and existing personal data is unchanged: the owner and their Only me chats keep it. The Agent learning page in a Personal workspace shows its Workspace layer beside "Your private chats". Publishing an Only me Site no longer silently shares it; share it first, as in any workspace.
