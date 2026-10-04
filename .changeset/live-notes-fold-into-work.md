---
"@opengeni/react": patch
---

Expanding a live turn's work row now reads like a finished turn: its progress notes are listed in order between the steps, and the copies above the row fold away in one short motion while the row rises into the first note's place (or the top edge) with its list beginning just beneath. Closing reverses it. Nothing else on screen jumps: the reader's position is held through the moment the page is briefly shorter, and closing from the sticky header lands back on the closed row.