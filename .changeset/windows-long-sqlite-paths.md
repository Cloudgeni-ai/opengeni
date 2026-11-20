---
"@opengeni/browserd": patch
---

Open the browser controller's SQLite files in the Windows extended-length form, so a controller root whose database paths reach 260 characters no longer fails with "unable to open database file".
