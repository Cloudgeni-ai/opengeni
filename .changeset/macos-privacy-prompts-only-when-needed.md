---
"@opengeni/desktop": patch
"@opengeni/runtime": patch
"@opengeni/agent-host": patch
"@opengeni/sdk": patch
---

macOS asks about fewer privacy permissions. The desktop window grants the microphone (dictation and voice chats) but no longer the camera, refuses USB, serial, HID and Bluetooth devices, and turns off Web Bluetooth; the app's own local pages get no permissions. On a Connected Mac whose agent works from the home folder, code search skips Library, Music, Pictures, Movies and the Trash unless a path names them, and also Desktop, Documents and Downloads until the owner has answered macOS about those in the app's setup. Repository discovery does the same as a safeguard. The Connected Machine instructions tell the agent not to scan those folders unasked.
