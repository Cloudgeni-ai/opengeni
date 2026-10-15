---
"@opengeni/react-native": patch
---

The native session composer now removes a message's attachments as soon as Send is acknowledged locally, the same as the web composer. Before, the tray kept the photos until the server accepted the message, so tapping Send again in that window re-sent the same files as an extra file-only message. Only the files that send captured are removed, so attachments added while it is in flight stay for the next message.
