---
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The card that asks to give a connected account more access now says which action it allows, for example "Allow Opengeni to organize your Gmail", what that includes, and that it applies to that account in every chat. It shows the service's logo, and its button goes straight to the provider's consent page ("Allow in Google"), shows that it is waiting, and says "Allowed" when done, with no setup dialog in between. Sign-in popups for these cards now close themselves when finished instead of loading the app inside the popup. When an agent hits the same missing access more than once, the chat shows one card.
