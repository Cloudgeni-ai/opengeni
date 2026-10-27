---
"@opengeni/browserd": patch
---

On macOS, Return or Enter sent to a window of a background app whose sheet holds the focus (an alert, a prompt) now presses the sheet's default button, as it would in the foreground. The posted key alone reached the sheet but never its default button, since the app looks for that key through its key window, which a background app does not have. The press goes through accessibility and does not bring the app forward; it is confirmed when the sheet closes. An ordinary window keeps the posted Return, which its fields, combo boxes, tables and search fields handle themselves.
