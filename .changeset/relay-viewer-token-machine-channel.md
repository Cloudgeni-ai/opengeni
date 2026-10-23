---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Live views of a Connected Machine (browser, desktop, terminal) work when the machine is connected in a different workspace than the chat using it. The relay viewer token used to carry the chat's workspace, so the relay refused it with "viewer token workspace does not match the channel key". The token now names the machine's relay channel (its workspace, machine and stream), and the relay only accepts it for that exact stream.
