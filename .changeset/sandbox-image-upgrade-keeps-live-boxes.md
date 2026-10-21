---
"@opengeni/runtime": patch
---

Changing the sandbox image no longer strands sandboxes that were running during the upgrade. Docker checked that it still owned a running container by comparing it with the newly configured image, so after an image change every live container failed that check: chats could not save their sandbox state and the reaper could not drain the container, and every turn failed until the database was repaired by hand. OpenSandbox likewise refused to resume, save or delete a sandbox whose recorded image or pool differed from the new configuration. Both now verify an existing sandbox against the image (and ports or pool) it was created with; the new image applies to sandboxes created after the upgrade, including the replacement started when a live sandbox rotates to the new image.
