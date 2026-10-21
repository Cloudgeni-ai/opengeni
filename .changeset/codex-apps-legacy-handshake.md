---
"@opengeni/runtime": patch
---

Connected ChatGPT apps (Outlook, SharePoint and the other Codex apps) are available in chats again. ChatGPT's apps server answers the newer protocol probe but returns tool lists in the older format, so every list was rejected and turns silently ran without those apps. Opengeni now connects to it with the older handshake, as it does for its own servers.
