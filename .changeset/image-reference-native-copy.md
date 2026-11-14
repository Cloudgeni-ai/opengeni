---
"@opengeni/worker-bundle": patch
---

Decoding a sandbox image that an image-generation request references now copies its bytes with `new Uint8Array(buffer)` instead of `Uint8Array.from(buffer)`. Bun runs the latter element by element when the source is a Node Buffer, which used about 16 times the image size in transient memory. The image bytes are unchanged.
