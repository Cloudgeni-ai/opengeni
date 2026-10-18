---
"@opengeni/browserd": patch
---

A browser `wait` for `visible` or `hidden` no longer fails with `locator_ambiguous` when its locator matches several elements. `visible` is satisfied when any match is visible and `hidden` when none is. Actions that target one element still refuse an ambiguous locator.
