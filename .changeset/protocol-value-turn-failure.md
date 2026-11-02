---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A turn whose history carries a request-local mark below the top level of an item no longer fails with "Protocol JSON value cannot contain symbol keys". When a protocol JSON boundary does refuse a value, the turn now ends with a clear message and the chat takes the next message, instead of the chat stopping with a Retry that fails the same way.
