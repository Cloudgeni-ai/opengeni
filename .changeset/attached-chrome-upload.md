---
"@opengeni/browserd": patch
---

File uploads now work in a person's own Chrome. Before, every upload there failed with "this browser placement cannot resolve workspace files for upload". Chrome lets an extension select local files directly only when "Allow access to file URLs" is on for it; when it is off, the files are now placed on the file input from the page instead, up to 32 MB per upload, with the same input and change events. Larger uploads fail with a message that names the setting.

Chrome's own refusals of a command on an attached tab are now reported as ordinary protocol errors with their real message, and a refused command no longer leaves the tab marked as possibly mid-input, which used to block reconnecting to it.
