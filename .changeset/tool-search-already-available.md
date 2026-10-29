---
"@opengeni/runtime": patch
---

`tool_search` no longer reports a tool the model already has as unavailable. Tools every request carries (such as `request_human_input`, `exec_command` or `web_search`) are not in the search catalogue, so asking for one by exact name returned it under `unavailable`, and a query matching one loaded something else. Agents read that as "this tool does not exist" and stopped using it. A search that names or clearly matches one of these tools now adds `alreadyAvailable`, a short note that it is already in the tool list and can be called directly, and leaves it out of `unavailable`. On routes with native tool search the note follows the search result.
