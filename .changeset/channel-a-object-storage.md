---
"@opengeni/api-router": patch
---

Computer and browser calls, and sandbox file artifacts, now restart a chat's parked sandbox with object storage. They reached the sandbox without it, so the first such call after the sandbox parked with its workspace archive in object storage failed with "sandbox not available (workspace archive object storage is not configured)", for example when a chat opened a computer again after its machine access was turned off and on. The services these calls use now require object storage, so no route can leave it out.
