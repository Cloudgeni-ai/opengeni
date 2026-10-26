---
"@opengeni/browserd": patch
---

A browser click or hover on an element that runs past the clipped edge of a panel holding it (a long tree row or label in a narrow side panel) is no longer refused as covered by whatever sits beside that panel, such as the main content group. The element's center lies past the panel's edge, where the panel beside it is on top, but that panel is not over the element: the driver now clicks the part of the element the panel shows, nearest its middle. A real cover over that part is still refused, naming it with "where it shows", and an element wholly past the edge gets a refusal that says so.
