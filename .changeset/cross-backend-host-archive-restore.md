---
"@opengeni/runtime": patch
---

Chats archived by a Local or Docker sandbox now continue after a deployment switches to a remote sandbox backend such as Modal. The host-backed workspace archive is converted into a portable tar, hydrated into the new sandbox, and every restored directory and file is verified against the archive before the sandbox is used. Previously the restore was refused and the chat became unrecoverable.
