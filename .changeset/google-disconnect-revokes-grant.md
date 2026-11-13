---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Disconnecting a Google account (Gmail, Drive, Calendar or a Google integration) now ends Opengeni's access at Google too: the disconnected connection no longer keeps any Google tokens, and the grant is revoked with Google once the disconnect is saved. Google revokes a grant for every connection of that Google account, so while another of your connections of the same account is still connected, the grant stays at Google and only the disconnected connection's tokens are deleted. When Google can't be reached, the stored tokens are still deleted. Other services disconnect as before.

`revokeConnection` accepts `replacementCredentialEncrypted` to replace the stored credential in the same write.
