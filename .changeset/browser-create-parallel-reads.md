---
"@opengeni/api-router": patch
---

Creating a browser reads its replay record and source session alongside the authorization check instead of after it. A denial still wins, neither read is used before the request is authorized, and each failure is reported at the same point as before.
