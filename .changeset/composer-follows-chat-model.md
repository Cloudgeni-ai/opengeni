---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

When the agent changes a chat's model (for example with `session_set_model`), the composer now shows the new model and the person's next message runs on it, instead of silently switching the chat back to the model the composer had loaded. A composer draft either holds the person's own pick or follows the chat's settings: `ComposerDraft.policyFollowsSession` says which, and while it is true the draft's `model`, `reasoningEffort` and `latencyMode` are the chat's current ones. `saveComposerDraft` and `submitComposerDraft` take those three fields together or not at all; without them the draft follows the chat and the message runs on its current settings. Picking a model, effort or speed in the composer still makes it the chat's setting when the message is sent, after which the composer follows the chat again. Composers on web, phone and embeds (`useComposer`) refresh on `session.model_settings.updated`, and `useComposer` exposes `sendPolicy`: the person's pick, or null while following. Clients that always send a model keep today's behaviour.
