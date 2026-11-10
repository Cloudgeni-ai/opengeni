---
"@opengeni/runtime": patch
---

A box that could not receive a private Git broker credential no longer fails every turn with a bare "Sandbox could not receive the Git broker credential". The error now names the underlying failure, with the credential redacted, and keeps it as its cause. A full disk now lets the turn start with a setup notice, so the agent can free space. An unanswered machine agent now reaches the worker's existing retry and box replacement. Other failed credential writes are retried in place up to two more times.
