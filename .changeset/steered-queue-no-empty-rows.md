---
"@opengeni/react": patch
---

Steering several queued messages one after another no longer leaves a stack of empty "Worked for" rows after the messages. A turn that handed over to the next Steer before doing anything but start up did no work of its own, so it now shows no work row; the turn that does the work still shows its own.
