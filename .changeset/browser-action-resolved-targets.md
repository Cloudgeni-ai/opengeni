---
"@opengeni/contracts": patch
"@opengeni/interaction": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Browser action receipts now say which element each locator resolved to: its role, name, reference, and the nearest dialog, landmark, menu or toolbar around it. A "Close" that hit the page header instead of a dialog is now visible in the receipt. Controllers add the field only when the caller asks for it, and never store it in their operation journal, so older and newer API and controller versions keep working together.
