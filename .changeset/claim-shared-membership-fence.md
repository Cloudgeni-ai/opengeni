---
"@opengeni/db": patch
---

Start first turns promptly under concurrent load in one organization. The turn claim now takes the organization-membership fence in shared mode, so claims no longer serialize each other, while membership mutators still fence them.
