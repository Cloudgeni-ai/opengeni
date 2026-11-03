---
"@opengeni/worker-bundle": patch
---

After a chat whose home box starts on demand switches to a machine with another workspace root, the attempt now ends before the next model request and the turn continues on the new machine. Previously the check read the raw home box, saw no route, and every later sandbox call in that attempt was refused as "Not run".
