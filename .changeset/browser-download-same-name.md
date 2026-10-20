---
"@opengeni/browserd": patch
---

Downloading a file with the same name as an earlier download in a managed browser no longer loses the earlier one. Chrome saves both under the same name, so the later file used to replace the earlier one, which then could not be read or saved. Each completed download now keeps its own bytes, and the Downloads folder still shows the files under their real names.
