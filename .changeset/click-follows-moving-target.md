---
"@opengeni/browserd": patch
---

A click whose target the page carries back out of the window just after it was scrolled to (for example a page that animates its own scroll to the accordion section an earlier click in the same batch opened) waits for the page to stop moving and scrolls to the target again, instead of failing with "out of view: nothing is at its center". A target no scroll can reach is still refused definitely.
