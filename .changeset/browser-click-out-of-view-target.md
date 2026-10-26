---
"@opengeni/browserd": patch
---

A browser click or hover on an element whose center is outside the window or a container's clip (for example a header link the page slides up while its content scrolls) now lands on the part of the element that still shows, instead of being refused as "covered or not pointer-actionable". That part must reach the element itself, not a separate control nested inside it (a card's own Delete button), and it stays inside the page's window, also from inside frames. Rotated or skewed elements are not sampled this way. When nothing else covers the element but it still cannot take the pointer, the refusal now says why and what to do: only a nested control shows, it is out of view with nothing at its center, it is out of view with only its own container there, or it has `pointer-events: none` (often disabled). Refusals that name a covering element are unchanged, and the old generic text remains for any other case.
