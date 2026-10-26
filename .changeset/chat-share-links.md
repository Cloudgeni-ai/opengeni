---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

A person can share a chat with a read-only link. The link opens a snapshot of the conversation exactly as the chat shows it (each person's messages under the name the chat shows for them, never an email, and the replies; queued messages that were deleted, edited or cancelled before they ran, images and links to the chat's own files left out) without signing in, and only while the person who shared it can still read the chat. The share page loads no third-party analytics that record its address and is never indexed. The person who started the chat creates, refreshes or stops it from the chat's Share… menu item or by asking the agent, which runs `createSessionShareLink` after one confirmation; `listSessionShareLinks` lists their links. `OPENGENI_PRIVACY_CHAT_SHARE_LINKS_ALLOWED=false` turns links off and stops existing ones opening. Member changes on a personal workspace now say that personal workspaces are private to their owner and point to a share link when that person can create one, instead of "missing permission: members:manage".
