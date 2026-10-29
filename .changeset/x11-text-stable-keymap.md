---
"@opengeni/browserd": patch
---

Linux X11 text no longer uses temporary spare-key bindings: a busy application
could read them after restoration and drop or repeat characters even though the
action reported success. Unmapped text is refused before any key is emitted.
Computer typing can use its existing validated paste fallback for ordinary
single-line text; secret references and text with control characters are not
automatically put on the clipboard. Existing error text is unchanged. Mapped
typing, Wayland and named function-key handling are unchanged.
