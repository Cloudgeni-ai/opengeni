---
"@opengeni/browserd": patch
---

Uploading a file through a button inside a cross-origin iframe now works. Before, the browser looked for the frame and its file chooser in the main page, which cannot see frames another site renders, so the upload failed with "upload control frame is unavailable". Upload dialogs embedded from another site, such as an office suite's add-in upload dialog, are common.
