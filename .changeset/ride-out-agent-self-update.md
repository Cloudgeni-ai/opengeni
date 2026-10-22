---
"@opengeni/runtime": patch
---

Browser, computer and file work on a connected machine no longer fails while its agent updates itself. The agent now downloads and verifies the new release before it stops taking new work, so it refuses new requests only for the few seconds the swap takes instead of for the whole download. Requests refused during that window are retried patiently until the updated agent takes them, whatever their kind. A request sent with a delivery token the previous agent process issued, which the updated process does not know, is sent once more with a fresh token instead of failing with an "invalid response" error, because the refusal proves it never ran.
