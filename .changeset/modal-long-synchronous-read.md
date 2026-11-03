---
"@opengeni/runtime": patch
---

Publishing a sandbox file larger than about 25 MB works on Modal sandboxes again. The upload asks to wait many minutes, but one Modal output read accepts at most 50 seconds, so the read was refused at once and the publish failed as "completion is pending or unknown". A longer wait is now split into bounded reads until the command exits.
