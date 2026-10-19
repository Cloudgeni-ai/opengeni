---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Browser observations now show what form fields contain (text inputs, text areas, search boxes, number fields), as the page shows them on screen, so an agent can read a draft or a prefilled form and check what it typed without a screenshot or an extra read. Password fields stay redacted. Every secret value a browser or computer session typed from a secret reference is now remembered for that session and redacted from all its later observations, page reads, dialogs, clipboard reads and window titles, not only from the result of the action that typed it. Field values longer than 2,000 characters are clipped in the page outline with their full length noted; `browser_read` with `mode: "dom"` returns more.
