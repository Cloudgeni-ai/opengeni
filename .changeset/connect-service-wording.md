---
"@opengeni/react": patch
---

Host apps can name and describe a connectable service in their own words, and that name is used everywhere the connect UI shows the service: discovery and chooser rows (with the description), connected accounts, the "Continue to …" sign-in step, the chat setup card, the setup dialog and the message people send their IT for approval. Pass `connectService.<providerId>.name` and `connectService.<providerId>.description` in `messages` on `OpenGeniProvider` or `OpenGeniMessagesProvider`, for example `"connectService.microsoft-outlook-calendar.name": "Outlook-kalender"`. Without them a service keeps its built-in name. `ConnectPanel` now also passes the service name to its setup step, so the IT approval message names the service instead of "my work account".
