---
"@opengeni/browserd": patch
---

Browser scrolling reaches the panel that holds the content in fixed layouts. A located scroll on an element that cannot move (for example a details region inside a page that never scrolls) now scrolls the scrolling panel under that element's centre, then its ancestors as before, then the largest visible scrolling panel inside it, instead of refusing with "nothing at this element can scroll further". A page scroll on a page that cannot move does the same for the panel under the viewport's centre. Form fields are not treated as panels. The page outline marks visible scrolling panels with the directions they can still scroll, for example `generic [ref] scrollable=down`, and lists their refs, so an agent can target the right panel first; pages without inner scrolling panels are unchanged.
