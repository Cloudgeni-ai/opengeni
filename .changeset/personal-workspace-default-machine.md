---
"@opengeni/contracts": patch
"@opengeni/core": patch
---

A Personal workspace's default machine can now be its owner's own (Only me) machine, so new chats there start on it. Chats that start on it still ask for the owner's personal-machine consent. Shared workspaces still need a shared machine. `machineCanBeWorkspaceDefault` in `@opengeni/contracts` states the rule. An automation still can't follow a workspace default that is a personal machine: the form no longer offers it, and the API and scheduled runs explain that the automation has to choose the machine.
