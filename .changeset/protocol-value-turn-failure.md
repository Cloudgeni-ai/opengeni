---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

When a protocol JSON boundary refuses a value a turn prepared (such as "Protocol JSON value at $ cannot contain symbol keys"), the turn now ends with a clear message and the chat takes the next message, instead of the chat stopping with a Retry that fails the same way. A goal does not keep continuing into the same refusal, and a turn whose completed work cannot be saved still stops the chat. As hardening, the history identity check also leaves out request-local marks below the top level of an item.
