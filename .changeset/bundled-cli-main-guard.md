---
"@opengeni/api-router": patch
---

Bundled database commands in server images run only when executed directly. Importing a bundled command module, for example from an image smoke check, no longer runs migrations or other commands against whatever database the environment points at.
