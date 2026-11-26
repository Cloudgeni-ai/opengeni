---
"@opengeni/react": patch
"@opengeni/api-router": patch
---

The Chrome setup card no longer flashes "Add the extension to Chrome" before it knows whether Chrome is linked. Until the first check finishes it shows a quiet "Checking for Chrome…" with no action, and a card shown again starts from the last known Chrome and computer state for that person and workspace while it refreshes. A failed first check still shows the step. The completed line reads "Connected.", naming the profile only when that adds something (more than one linked Chrome, or a profile with its own name), for example "Connected (Work).".

A Chrome card that sees Chrome linked now clears its chat's wait on the person, so a finished card no longer marks the chat, or the sub-session bar above it, as needing them. `POST …/capability-continuations` for `api:connected-machine` withdraws that chat's Connected Machine card notice only when the chat's latest machine request is the Chrome one, the chat is still waiting, the caller is the person who was asked, and they have a linked Chrome; it still sends nothing to the agent. `SessionCapabilityFrame` takes a new optional `pending` prop that hides the action while a card is still checking.
