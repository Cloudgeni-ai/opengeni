---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Clear a Connected Machine session's saved working directory when it is the filesystem root `/` or a Windows `System32` service launch directory left by older agents, so attachments, tool results and generated images work again in those chats. A filesystem or drive root, or anything inside the Windows directory, is never used as a working directory; the machine's reported root applies instead. The agent also moves out of the Windows system directory into the user's home, as it already did for a filesystem root.
