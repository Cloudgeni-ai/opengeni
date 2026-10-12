---
"@opengeni/browserd": patch
---

A browser click or hover on a control that only accepts the pointer while its row or card is hovered (a common pattern for row actions such as "add" or "more" buttons) now moves the pointer onto it first, as a person would, and then clicks. Before, the hit test fell through the hidden control to its row and the action was refused. A control that stays unreachable after the pointer arrives is still refused, reported as an unknown outcome because the pointer moved.
