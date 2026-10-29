---
"@opengeni/browserd": patch
---

Typing with `mode: "keys"` into split one-time-code boxes no longer drops characters on a busy machine. Between characters, a visible tab now waits for its next frame for up to a second. Before, it gave up after 50 ms, and when the frame came later than that, the next key went to the box that was already full. Hidden tabs, which draw no frames, still wait only 50 ms.
