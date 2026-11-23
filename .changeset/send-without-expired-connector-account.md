---
"@opengeni/core": patch
"@opengeni/react": patch
---

A message is no longer refused when one of its connector accounts stopped working after the chat was opened (for example its sign-in expired). It is sent without that account, the connector shows as needing reconnecting for that turn, and no other account is used in its place. A chat left open re-reads its accounts when you return to it, and reconnect notices name the service (Atlassian, not "Mcp").

If a server still refuses such a message, the chat re-reads its accounts and sends it again once on its own without the accounts that stopped working, with no failed message to resend. It never adds or swaps in another account; when leaving a pick out would let the connector use an account you didn't pick, or the second send is refused too, the message shows as failed as before.

"Reconnect required" on a connector in + → Connectors now stays until you reconnect it or turn it off for the chat, including in a Personal workspace, where a connector from another workspace used to disappear once its account stopped working. The Open PR button no longer has a glow, matching the other primary buttons.
