---
"@opengeni/browserd": patch
---

On macOS, Return or Enter sent to a window of a background app now presses the default button of that window or of the sheet open on it (an alert's OK, a prompt's OK), as it would in the foreground. The posted key alone reached the sheet but never its default button, since the app looks for that key through its key window, which a background app does not have. The press goes through accessibility and does not bring the app forward; it is confirmed when the sheet closes.
