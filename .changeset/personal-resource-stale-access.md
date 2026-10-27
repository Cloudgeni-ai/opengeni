---
"@opengeni/db": patch
"@opengeni/core": patch
---

A message sent with personal resources (a connected machine, rig or variable set) just after the chat's access changed, for example right after it was made private, now gets a 409 that says the chat's access changed and asks to check the attached resources and send it again. It used to fail with a generic 500. The same refusals for an invalid, unauthorized or conflicting attachment now reach the client as the 422, 403 and 409 they were meant to be, instead of being reported as database persistence failures.
