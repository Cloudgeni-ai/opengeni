---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

A session with full access now reaches a chat in another workspace of the person who gave it with the ordinary session tools: session_get, session_events, session_wait, session_send_message, session_steer, session_pause and session_resume take an optional workspaceId and run there as that person, through the same authority as admin_action_call. Without full access the tools say plainly that they reach only this workspace's chats; a chat that doesn't exist and a workspace the person can't use read the same. session_wait and session_steer now also serve sessionless callers (a sessionless steer is a human/API steer), and admin_actions_search also names reading, messaging or managing chats in another workspace with full access, so tool search finds it.

Session tools also return each chat's canonical link (`chatUrl`), built from the deployment's web base URL (falling back to the public base URL) and the chat's own workspace: on every sessions_list row, session_get (including an agent's self read) and session_create's receipt facts. A chat in another workspace gets its link there. It is omitted when no base URL is configured.
