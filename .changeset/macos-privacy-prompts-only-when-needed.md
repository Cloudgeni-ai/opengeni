---
"@opengeni/desktop": patch
"@opengeni/runtime": patch
"@opengeni/agent-host": patch
"@opengeni/sdk": patch
---

macOS asks about fewer privacy permissions. The desktop window grants the microphone (dictation, voice chats and meeting recordings) but no longer the camera, refuses USB, serial, HID and Bluetooth devices, and turns off Web Bluetooth; the app's own local pages get no permissions. On a Connected Mac whose agent works from the home folder, code search skips Library, Music, Pictures, Movies and the Trash unless a path names them, and each of Desktop, Documents and Downloads until the owner has allowed the app to open it. Repository discovery does the same as a safeguard. The Connected Machine instructions tell the agent not to scan those folders unasked.
