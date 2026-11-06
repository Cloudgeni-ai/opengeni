---
"@opengeni/runtime": patch
"@opengeni/codex": patch
"@opengeni/worker-bundle": patch
---

A session switched to another Responses provider (for example from a Codex model to an xAI model, including a turn that was waiting for capacity) now continues instead of failing with "Could not decrypt the provided encrypted_content". Encrypted reasoning can be read only by the provider that issued it, so each such reasoning item now records its issuing provider, and a request to any other provider carries the readable summary in its place ("[Historical reasoning from another model]", as Claude and Chat models already got) instead of the ciphertext. The issuing provider still receives exactly the same request bytes as before. Reasoning stored before this change has no record; if a provider refuses it, that request is sent once more with the summaries, and later requests to that provider send the summaries directly. `classifyEncryptedArtifactRejection` recognizes that refusal from any provider.
