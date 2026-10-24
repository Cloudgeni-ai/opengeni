---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

Computer readings on Linux and Windows now show whether a checkbox or switch is on (value "1" or "0", as on macOS); before, browserd dropped the state CUA reports, so agents could not see it and set_value true or false on one was refused. Linux switches and toggle buttons now report their state too. The computer_act description says that set_value true or false on a checkbox or switch leaves it in that state and presses it only when needed, so one batch can cover a whole record without reading the checkbox first.
