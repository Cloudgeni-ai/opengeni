---
"@opengeni/browserd": patch
---

A browser click or hover on an element whose center is outside the window or a container's clip (for example a header link the page slides up while its content scrolls) now lands on the part of the element that still shows, instead of being refused as "covered or not pointer-actionable". When nothing else covers the element but it still cannot take the pointer, the refusal now says why and what to do: it is out of view with nothing at its center, it is out of view with only its own container there, or it has `pointer-events: none`. Refusals that name a covering element are unchanged, and the old generic text remains for any other case.
