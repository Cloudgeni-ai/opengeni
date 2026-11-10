---
"@opengeni/db": patch
---

Turn timing profiles: a router (`tool_invoke`) call whose arguments were stored as a JSON string made the profile query fail with an invalid regular expression, so the sweep skipped the rest of that workspace. The pattern now stays within PostgreSQL's limit, and a page of turns whose history cannot be read is reported and skipped while the pass moves on.
