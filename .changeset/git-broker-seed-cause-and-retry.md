---
"@opengeni/runtime": patch
---

A box that could not receive a private Git broker credential no longer fails every turn with a bare "Sandbox could not receive the Git broker credential". The error now names the underlying failure, with the credential redacted, and keeps the redacted original as its cause. A full disk, or a blocked or unwritable path the machine agent reports, now lets the turn start with a setup notice, so the agent can fix its box. An unanswered machine agent now reaches the worker's existing retry and box replacement. A failed credential write that may succeed when sent again (a lost response, or an error the machine agent marks retryable) is retried in place up to two more times.
