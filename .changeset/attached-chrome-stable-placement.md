---
"@opengeni/browserd": patch
---

Keep attached Chrome sessions alive across agent restarts, agent updates and native-host reconnects. Every native reconnect used to give the profile a new connection generation, which ended all of its live browser sessions with `controller_transition_expired`, so an agent update or a brief native-host exit lost every agent's attached browser. The extension now also reports a state generation that lasts for its worker's lifetime, the span in which Chrome keeps its tab ids and debugger attachments, and the agent binds the profile's placement to it while still fencing each native port with the per-port generation. Because a quiescent attached session now survives a restart, it no longer holds back an agent update; the agent still waits while an older extension without a state generation backs a live attached controller.
