---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Sites published from an "Only me" chat are readable by the whole workspace again. The private-chat row policy had also been applied to Site versions and Site history through their source-chat column, so other members saw the Site listed but could not open any version. Versions and history now follow workspace access only; the source chat, turn and attempt stay redacted for anyone who cannot read that chat. A Site with no version the viewer can open now shows a clear message with Retry instead of loading forever.
