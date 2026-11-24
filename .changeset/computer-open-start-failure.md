---
"@opengeni/runtime": patch
---

`computer_open` now reports a computer that failed to start as an error with the controller's reason (`ComputerSession <id> did not start: …`), as `browser_open` already does, instead of an opened computer with no screens.
