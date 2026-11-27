---
"@opengeni/db": patch
---

The editable artifact schema check and the two wake repair inventories now plan cheaply: the schema check looks up its six tables in one catalog query instead of an 8-way join, and the inventories reuse one plan per connection instead of planning again on most calls. Results are unchanged.
