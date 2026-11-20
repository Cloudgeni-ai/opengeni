---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A turn with an attached file no longer fails before it starts when file storage can't be mounted into the sandbox (Azure Blob on Modal, or AWS S3 or GCS). The workspace layout the agent reads was built with a mount entry for each file, which needs the pre-signed download the file is actually delivered by. The layout lists no files, so it now leaves them out, and the file arrives by its pre-signed download as before.
