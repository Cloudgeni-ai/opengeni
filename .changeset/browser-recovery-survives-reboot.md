---
"@opengeni/browserd": patch
---

A managed browser's preserved profile can be relaunched again after its Linux machine reboots. Linux can give the disk a new device number at boot, and recovery took that for a moved or copied profile and refused it, so the browser was recorded as lost. After a reboot, a profile with the same inode at the exact recorded path now counts as the same directory. Within one boot the device number must still match, and a copied or moved profile is still refused.
