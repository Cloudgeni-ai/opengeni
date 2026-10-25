---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

The agent now continues on its own after a person finishes setting up a capability from the agent's connect or add-credentials card, instead of waiting for them to say they are done. After setup is verified, the shared chat cards (and the OAuth return handlers) call the new `POST /v1/workspaces/:workspaceId/sessions/:sessionId/capability-continuations` endpoint (`client.continueAfterCapabilitySetup`). The API records one immediate `capability_setup_completed` internal update per card, and only when the capability is now usable in that chat, nobody has written since the card, and the caller is the person whose request it was. The agent sees one short internal update saying the setup is finished and its tools are available. Failed or cancelled setup sends nothing.

`SessionConversation` and `OpenGeniChat` now render the shared connect card for the agent's OAuth capability requests with no host code, when the person's grant allows every setup step; otherwise the card says the integration can't be connected from here instead of showing a dead end. The session proxy reports a new `chatConnections` client-config field (`false` when its `createSession` hook owns chat tools), and `timelineProps.renderAuthNeeded` still takes precedence.
