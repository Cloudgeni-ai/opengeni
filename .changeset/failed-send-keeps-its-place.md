---
"@opengeni/react": patch
---

A failed send no longer sits under newer messages and running tools. When the person has sent something newer, the failure keeps its place before that message, so it no longer looks like the latest thing they said. With nothing newer, it stays last, next to the composer.
