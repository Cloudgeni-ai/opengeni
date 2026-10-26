---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Closes several trust-boundary gaps reported by Vasu Bansal (#2664). The stream relay now enforces the viewer token's mode: a watch-only token can no longer type into or close a terminal, or send desktop input, and every input or close must name the viewer's own stream. A connection replaced by a reconnect can no longer act on its successor. Terminal tokens for viewers with terminal access carry input authority, independent of desktop control. An organization API key can no longer approve its own calls to tools that need a person's approval. Managed sign-in no longer fails when the API host's clock runs ahead of the database, and the device-enrollment rate limiter no longer grows without bound.
