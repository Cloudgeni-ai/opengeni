---
"@opengeni/sdk": patch
---

A discarded recording stays discarded. Before, if the background upload was saving the recording's progress at the moment of discard, the saved copy could come back on the device. If the server copy was being created at that moment, it stayed on the server. Discard now waits for that save to finish. A server copy created just after the discard is deleted.
