---
"@opengeni/desktop": patch
"@opengeni/runtime": patch
---

macOS asks about fewer privacy permissions. The desktop window grants the microphone (dictation and voice chats) but no longer the camera, refuses USB, serial, HID and Bluetooth devices, and turns off Web Bluetooth. On a Connected Mac whose agent works from the home folder, code search and repository discovery skip Desktop, Documents, Downloads, Library, Music, Pictures, Movies and the Trash unless a path names them, and the Connected Machine instructions tell the agent not to scan those folders unasked.
