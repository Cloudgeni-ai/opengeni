---
"@opengeni/runtime": patch
---

A chat with a personal GitHub repository attached can now also use repositories whose URL starts with the same name, such as `opengeni` together with `opengeni-demos`. Before, the personal GitHub rewrite also caught the other repository, and repository preparation failed with "Git repository route not found". The `.git` clone URL of a personal GitHub repository now also goes through the broker.
