---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Tell the model who sent each person's message. Members of a shared workspace talk to the same agents, and the model previously saw only the message time, so it could mistake one member for another. A claimed human message's metadata part now reads `[Message sent <time> by <sender>]`, using the sender label frozen with the turn at acceptance (normally the member's email). The label is made safe for the one-line part: no brackets or line breaks, at most 200 characters. Agent, service and scheduled turns carry no sender. Realtime voice requests and the end-of-call transcript handoff now carry the caller's own label instead of the generic "Realtime" label when the request has one.
