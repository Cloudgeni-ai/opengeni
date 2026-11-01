---
"@opengeni/react": patch
---

Claude and SuperGrok chats show the subscription account menu in the chat header again, with each account's usage, the same way Codex chats do. The header chose the provider from the model's `credentialSource`, which the workspace model catalog never sends, so only Codex (recognised by its model id) ever got a menu. The provider now also comes from the Claude subscription model and provider ids and the model's public rail. The same fix makes the model details name Claude subscription billing instead of Codex. Each account row in the menu also has a small bar for its most-used usage window again, next to the usage text.
