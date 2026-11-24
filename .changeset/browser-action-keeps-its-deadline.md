---
"@opengeni/browserd": patch
---

A browser action on a page that keeps its main thread busy now answers within the time its caller waits, and says whether input was sent. Nearly every page read an action makes (finding its element, scrolling it into view, checking what is under the pointer) waits for the page's main thread, so on such a page one click's few dozen reads could take minutes. The caller gave up at its deadline with "may still be running", although the click often went through later. The action now keeps to that same deadline, less ten seconds for the reply. If the page was too slow before any input, it fails with `tab_not_responding` and says nothing was sent. If the input was already sent, it reports an unknown outcome that says so. Input events themselves keep their own bound, so a pressed button always gets its release.
