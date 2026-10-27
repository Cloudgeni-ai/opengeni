---
"@opengeni/api-router": patch
"@opengeni/connect": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

In-chat connection requests now read the same to the person and to the agent, and the sign-in window ends cleanly in embedded chats. When the person in the chat can't connect the requested integration from the card (their access doesn't allow it), `capability_authorization_request` now tells the agent so, instead of the generic "posted for confirmation" message, so it no longer asks them to use a card that can't help them. Results for people who can connect are unchanged. The card and the server share one rule for this decision (`inChatCapabilitySetup` in contracts), and the server applies it to the same access the person's chat has: what their sign-in could do when they sent the turn's message, or their latest message in that chat for a turn the platform started for them, such as a wake-up, a child's result or a goal continuation (an embed token narrows it, and their own workspace counts without a membership). Without such a message it falls back to their membership (`readTurnSenderAccess` in db). The console's chat card uses the same rule, so it no longer offers Connect to a member the agent was told can't connect.

In-chat connect cards also start sign-in with a new optional `finishInPopup: true` flag on `POST /v1/workspaces/:workspaceId/connect/attempts`. The provider's callback then lands on a small server page that closes the sign-in window (or tells the person they can close it) instead of loading a second copy of the host page in the popup. Without the flag the return URL behaves as before. Against an older server that rejects the unknown field, `ConnectController.begin` starts again without it, so sign-in keeps working and returns to the host page as before. Browser cards set it, because they sign in through a popup. Phone cards don't, because the system sign-in browser returns to the app.

Reviewed catalog integrations no longer carry an "MCP server" label on their connection cards and dialogs, on the web and on the phone. They read as the service itself, with its name and provider. Servers someone added by hand, and registry entries nobody reviewed, keep the label (`showsMcpServerLabel` in `@opengeni/react/in-chat-connect-model`).
