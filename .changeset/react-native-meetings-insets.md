---
"@opengeni/react-native": patch
---

The meetings list and meeting screens from `@opengeni/react-native/meetings` now let iOS keep their content clear of the navigation bar, tab bar and home indicator (`contentInsetAdjustmentBehavior="automatic"`), so they also work under a translucent header. `bottomInset` is now only extra space, such as Android's bottom safe-area inset.
