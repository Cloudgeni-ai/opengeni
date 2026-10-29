---
"@opengeni/browserd": patch
---

Browser clicks reach partly visible elements:

- A click aims at a part of the element that shows and takes the pointer, including a link whose visible content lies outside its own box or only on one side of its clipped center. Only an element with no reachable visible part is refused. The search skips subtrees that are not rendered (a closed submenu), and stays bounded for large elements.
- A refusal made before any input was sent is a definite failure. The driver scrolling the element into view no longer turns it into an unknown outcome.
