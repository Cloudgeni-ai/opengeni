---
"@opengeni/browserd": patch
---

Clicking an option of a native dropdown whose list is open no longer sends the page a stray Escape key release when the list closes; the page sees no key events, as when a person picks an option. Options hidden by an `optgroup` with the `hidden` attribute or by CSS `display: none` are now refused like disabled ones.
