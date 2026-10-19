---
"@opengeni/db": patch
---

Deleting a workspace that holds a connection no longer fails with "connection owner authority is immutable" on databases where PostgreSQL happens to fire the connection's origin foreign key action before the workspace cascade. The origin foreign key now cascades like the workspace one, and a connection's owner authority and origin stay immutable.
