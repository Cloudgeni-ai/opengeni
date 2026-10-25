---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A Mac whose screen is locked, or shows another user's session, no longer offers this session's windows as computer targets. macOS keeps listing them in that state, but every read of one came back empty (`ax_window_unresolved`) and input never reached them. `computer_open` now opens the computer with no targets and says plainly why and what a person must do; listing, observing, capturing and acting fail with `machine_locked` and the same reason, and the same computer works again once the screen is unlocked or switched back. The state is read natively by the new `computer-native window console` command from this session's CoreGraphics dictionary, the IORegistry's `IOConsoleLocked` and the owner of `/dev/console`: after a switch to another user, this session's own dictionary can still claim the console.
