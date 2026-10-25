---
"@opengeni/api-router": patch
"@opengeni/connect": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

In-chat connection requests now read the same to the person and to the agent, and the sign-in window ends cleanly in embedded chats. When the person in the chat can't connect the requested integration from the card (their access doesn't allow it), `capability_authorization_request` now tells the agent so, instead of the generic "posted for confirmation" message, so it no longer asks them to use a card that can't help them. Results for people who can connect are unchanged. The card and the server share one rule for this decision (`inChatCapabilitySetup` in contracts).

In-chat connect cards also start sign-in with a new optional `finishInPopup: true` flag on `POST /v1/workspaces/:workspaceId/connect/attempts`. The provider's callback then lands on a small server page that closes the sign-in window (or tells the person they can close it) instead of loading a second copy of the host page in the popup. Without the flag the return URL behaves as before. Browser cards set it, because they sign in through a popup. Phone cards don't, because the system sign-in browser returns to the app.

Reviewed catalog integrations no longer carry an "MCP server" label on their connection cards and dialogs, on the web and on the phone. They read as the service itself, with its name and provider. Servers someone added by hand, and registry entries nobody reviewed, keep the label (`showsMcpServerLabel` in `@opengeni/react/in-chat-connect-model`).
