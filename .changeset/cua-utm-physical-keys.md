---
"@opengeni/browserd": patch
---

Text typed into a UTM virtual machine window now arrives as the letters sent, not as a row of "a". UTM passes each key event's key code to the guest's keyboard and drops the Unicode text a synthetic event carries, so text sent the usual way (Unicode on key code 0, the A key) reached the guest as "aaaa". The pinned CUA driver now treats UTM like Screen Sharing, the iOS Simulator and iPhone Mirroring and types into it as physical keys.
