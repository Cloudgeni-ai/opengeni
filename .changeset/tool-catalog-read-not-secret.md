---
"@opengeni/contracts": patch
---

In chat, the agent can again read the workspace tool catalog and declarations, and resolve, describe or get a manifest of workspace tools, through app actions. These calls were treated as handling a secret because the SDK client that serves them also serves tool approvals, which return an approval token. The app action catalog now names exactly what each of them returns; approval, invoke and call routes stay marked.
