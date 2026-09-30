---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": patch
---

Make browser sign-in the default Claude subscription connection flow, with profile access for current usage/reset times and encrypted automatic token renewal. Reuse native workspace/organization connection ownership and access policy, bind one-use PKCE attempts to the human/browser/current generation, and preserve original model-request bindings across token renewal. Keep inference-only setup tokens as a clearly labelled fallback, and send JSON for browser usage-refresh mutations.
