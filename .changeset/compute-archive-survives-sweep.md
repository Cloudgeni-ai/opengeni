---
---

An archive in flight when an hourly sweep takes stock of the stored copies now still lands. The sweep's fence stops that try from publishing, so the archive tries again at once with the same files: everything the stopped try uploaded was kept and carried into the new hour, so the new try only checks it and publishes. Before, the whole archive step failed and was tried again after a pause, capturing and uploading the sandbox again, so on a slow store, where archives take many minutes, most of what was uploaded around each sweep was thrown away and became garbage for the next sweep.
