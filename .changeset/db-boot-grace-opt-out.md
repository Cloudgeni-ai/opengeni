---
"@opengeni/db": patch
---

Database clients can opt out of the startup connect grace with `bootConnectGraceMs: 0`, so a refused connection fails immediately where that is the point.
