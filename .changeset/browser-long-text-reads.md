---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/codemode": patch
---

Long text in a browser page can now be read in full. The outline says how long a clipped name, description or value really is (`valueChars=7089`), keeps the ref on a clipped text line, and notes once that `browser_read` mode=dom with that ref reads the rest. DOM element reads take `offset` and allow up to 32,768 characters per read; a truncated read returns `nextOffset` to read on. Clipboard copy of an element with no `content` now copies its selected text or, when nothing is selected, all of what it shows; before, it silently copied nothing. `content: "value"` works on custom text boxes (role=textbox and editable content), and a copy that finds nothing to copy says why and what to use instead, rather than "browser clipboard source is unavailable".
