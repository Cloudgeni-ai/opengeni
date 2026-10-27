---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Closes several trust-boundary gaps reported by Vasu Bansal (#2664). The stream relay now enforces the viewer token's mode: a watch-only token can no longer type into or close a terminal, or send desktop input, and every input or close must name the viewer's own stream. Dropped messages are counted in `opengeni_relay_unauthorized_drops_total`. A connection replaced by a reconnect can no longer act on its successor. Terminal tokens for viewers with terminal access carry input authority, independent of desktop control. Approving a tool call that needs a person's approval now requires a person: an organization API key acting as itself gets 403 and must approve on behalf of a verified external actor (`x-opengeni-external-actor`), after the host shows its own approval UI. Managed sign-in no longer fails when the API host's clock runs ahead of the database, and the device-enrollment rate limiter no longer grows without bound.
