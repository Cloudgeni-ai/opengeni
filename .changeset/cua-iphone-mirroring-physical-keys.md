---
"@opengeni/browserd": patch
---

Typing into iPhone Mirroring on macOS now arrives as the intended text. iPhone Mirroring passes each key event's key code on to the phone and ignores the text a synthetic event carries, so typed text arrived as "aaaa" and a code typed into a field left it empty. The pinned CUA driver now sends it the physical keys for each character, as it already did for Screen Sharing and the iOS Simulator.
