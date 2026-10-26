---
"@opengeni/agent-host": patch
"@opengeni/desktop": patch
---

Turning on Computer use in a second workspace no longer fails with "this machine was first connected as a personal machine from another workspace". When the computer's existing connection was made without screen control, the app now turns screen control on for that connection (where it was made) and lets agents in the new workspace use it, instead of setting the computer up anew, which the server refuses for a person's own computer. On the server, a personal computer that was removed can now be connected again from any workspace its owner uses; before, it could only come back in the workspace it was first connected from.
