---
"@opengeni/runtime": patch
---

Saving and restoring a Modal sandbox's workspace as a tar in object storage no longer holds the archive in worker or API memory. The tar streams between `tar -c` / `tar -x` in the box and a private disk spool through Modal's exec streams, checked and hashed chunk by chunk, so peak memory no longer grows with the archive (a 419 MB archive: restore +3.4 GB and save over 15 GB before, about +9 MB and +55 MB now). Every object-storage tar is restored from a spool verified against its descriptor before any box is created; any other provider reads that spool into one buffer instead of fetching, base64-encoding and decoding it.
