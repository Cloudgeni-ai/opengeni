---
"@opengeni/browserd": patch
---

A macOS button press or item open that macOS answers with "cannot complete" (-25205) is checked against the windows afterwards: a changed window, or the one window the app opened when the press closed its own, completes the action with that reading. An unchanged window stays outcome_unknown, and a window that closed says so instead of claiming that nothing changed.
