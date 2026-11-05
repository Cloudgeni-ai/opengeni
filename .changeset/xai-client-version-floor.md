---
"@opengeni/xai-subscription": patch
"@opengeni/core": patch
---

SuperGrok works again after xAI raised its minimum Grok CLI version. Requests now present the current Grok CLI stable release (1.0.70) instead of 1.0.3, which xAI refuses as outdated. When xAI raises its minimum again, the transport adopts the version its refusal names and retries the request once, so Grok turns keep working until the pin catches up; a daily workflow keeps the pin on the stable channel. A refusal that still persists fails the turn with the code `xai_client_outdated` and a plain message, and never marks the connected account as needing sign-in or as broken.
