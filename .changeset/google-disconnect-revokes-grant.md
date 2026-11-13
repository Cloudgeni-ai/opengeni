---
"@opengeni/db": patch
---

Disconnecting a Google account (Gmail, Drive, Calendar or a Google integration) now ends Opengeni's access at Google too: the stored refresh token is revoked with Google, and the disconnected connection no longer keeps any Google tokens. When Google can't be reached, the stored tokens are still deleted. Other services disconnect as before.

`revokeConnection` accepts `replacementCredentialEncrypted` to replace the stored credential in the same write.
