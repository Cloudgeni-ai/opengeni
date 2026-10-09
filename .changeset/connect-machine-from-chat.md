---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": patch
---

Connect a machine from the chat. Agents can post a Connected Machine card (`capability_authorization_request` with `api:connected-machine`, or `sandbox_provision` with `kind: "selfhosted"`) the way they request integrations. The person copies a one-line Mac/Linux or PowerShell command minted in their browser, the card notices when the machine comes online, and **Use in this chat** moves the conversation there. Once a machine is connected, the card links the OpenGeni Browser Chrome extension and shows when Chrome is linked. Agents that can already reach a machine install it themselves with `connected_machine_enroll_token`, and their tool guidance now names the extension link and the machine-first requirement.

Enroll tokens are now single-use: each carries a `jti` that the exchange records (migration 0696), so one token connects one machine. The same machine may repeat the exchange while it is still enrolled; another machine, or a machine removed since, gets `401`. Tokens minted before this release stay multi-use until they expire. The Machines page connect dialog shares the new command component, adds Windows, and no longer calls a multi-use token "one-time".
