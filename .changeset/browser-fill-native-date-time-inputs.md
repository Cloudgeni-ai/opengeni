---
"@opengeni/browserd": patch
---

Browser fill now works on native date, time, month, week and datetime-local inputs. Fill sets the input's value in its own format (for example HH:MM for time) and notifies the page as user input, whether the locator points at the input or at one of its hour, minute or date parts. Previously it cleared the focused part and then reported an unknown outcome. A value that does not match the input's format is refused before anything changes, with the expected format in the error. Snapshots offer fill on the input itself, not on its part spin buttons.
