---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A message is no longer refused when one of its connector accounts stopped working after the chat was opened (for example its sign-in expired). It is sent without that account: the connector keeps your other picks that still work, or runs without an account for that turn, and no other account is used in its place. The left-out account is recorded on the turn, logged, and an expired sign-in posts its reconnect notice in the chat, addressed to the person who sent the message (not the chat's owner in a shared chat) and posted once while the account stays broken, so a dismissed notice stays dismissed. Work that continues the message narrows the same way, keeping your working picks rather than dropping the connector. An account id you can't see, or one that belongs to another connector, is still refused, and personal GitHub and social account picks stay strict because a repository or post can't be attached without that account. A chat left open re-reads its accounts when you return to it, and reconnect notices name the service (Atlassian, not "Mcp").

In the composer, a picked account that stopped working stays picked and shows "Reconnect required" on the connector and on the account, with a Reconnect action for that account. Send stays enabled.

If a server still refuses such a message, the chat re-reads its accounts and sends it again once on its own, leaving out a pick that stopped working only where the connector keeps another pick, with no failed message to resend. Only that resend is narrowed: your picks stay as you made them, so the account is used again once you reconnect it. It never adds, swaps or widens accounts: when no such resend exists, or the second send is refused too, the message shows as failed as before.

"Reconnect required" on a connector in + → Connectors now stays until you reconnect it, including after a reload and on other devices. In a Personal workspace, a connector carried from another workspace used to disappear from the connector list once its account stopped working; the list now keeps it, marked as needing reconnecting, while chats still never run it with that account. The Open PR button no longer has a glow, matching the other primary buttons.
