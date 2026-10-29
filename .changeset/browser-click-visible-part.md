---
"@opengeni/browserd": patch
---

Browser clicks reach partly visible elements and no longer stall in background tabs:

- A click aims at a part of the element that shows and takes the pointer, including a link whose visible content lies outside its own box or only on one side of its clipped center. Only an element with no reachable visible part is refused.
- A refusal made before any input was sent is a definite failure. The driver scrolling the element into view no longer turns it into an unknown outcome.
- In a tab that is not in front, a click no longer waits about five seconds for Chrome to acknowledge the pointer's move. The pointer still arrives before it presses, and the hit-target guard is unchanged.
