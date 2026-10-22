---
"@opengeni/react": patch
---

The packaged voice control keeps the model of a voice conversation that is already running when the voice model catalog loads afterwards (for example after reopening a session with a live call). It no longer switches to the workspace's or organization's default model and replaces the running call's controller.
