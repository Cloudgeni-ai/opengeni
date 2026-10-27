---
"@opengeni/react": patch
---

Codemode works on a personal ("Only me") Connected Machine used from a chat in another workspace. The machine's runner now keeps the workspace the control plane addressed and replaces only the server address, instead of pointing Codemode at the workspace that enrolled the machine, where the chat's token was refused with 403 "workspace access denied". Takes effect with the next runner release. Machine pickers also say who can use a machine ("Only me", "Workspace") when two listed machines share a name.
