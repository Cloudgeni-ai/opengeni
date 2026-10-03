---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Require an explicit server-enforced screen grant for managed ComputerSession RFB input. Preserve viewing with pixel-only grants, recheck controller and target authority before forwarding packets, and use canonical frames and actions with older controllers. Desktop viewers default old attachments to view only.
