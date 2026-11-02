---
"@opengeni/db": patch
"@opengeni/api": patch
"@opengeni/react": patch
---

Forking a chat at an agent reply that was sent through `wait_for_input`'s `reply` now works: the fork ends at that wait call and its result. Such replies were refused as "from before the conversation was compacted"; the remaining refusal for a message with no matching history point now says so plainly.
