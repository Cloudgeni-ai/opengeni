---
"@opengeni/browserd": patch
---

A browser click or hover on an element that runs past the clipped edge of a panel holding it (a long tree row or label in a narrow side panel) is no longer refused as covered by whatever sits beside that panel, such as the main content group. The element's center lies past the panel's edge, where the panel beside it is on top, but that panel is not over the element: the browser's own hit stack leaves the element out there. The driver now clicks the part of the element that shows, at its middle. A real cover over that middle is still refused, naming it with "where it shows"; an element covered at its center, including one in the top layer such as an open popover, keeps the "at its center" refusal; and an element wholly past the edge gets a refusal that says so. The cover's name in these refusals is now at most 160 bytes of UTF-8 and never splits a character.
