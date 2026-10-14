---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Attached browsers follow their machine's audience.

- A personal (Only me) machine's browsers are listed, read and controlled only for the machine's owner. Before, any workspace member could see them, and the browser and linked-desktop control paths reached the machine without the owner check that normal machine use applies. An agent counts as the person whose turn it runs for; keys and services see no personal machines.
- A revoked machine's browsers no longer show as connected with their old profiles and tab counts. They read as disconnected (from when the machine was revoked) and leave the default listing.
