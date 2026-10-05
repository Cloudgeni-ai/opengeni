---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/interaction": patch
---

Negotiate native desktop click continuation so viewers send the first click immediately and submit the real second click while its HTTP receipt is pending. Require the exact completed first operation plus one-use native delivery proof, preserve painted-frame coordinates and geometry, and reject failed, unknown, expired or unrelated continuations without replay. Later viewer input waits for both outcomes; Linux physical input serializes without queuing independent background AT-SPI actions. Background native mutation admission fences click proof through completion, cancellation and panic so overlapping work cannot restore authority.

Keep bounded original Window keyboard/clipboard identities across read-only refreshes, with live object, process, geometry and focus revalidation. Preflight whole key batches before input, and reject Window pointer points covered by another X11 client. Preserve uncertain outcomes after any possible input delivery.
