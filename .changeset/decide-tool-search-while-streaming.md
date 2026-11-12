---
"@opengeni/runtime": patch
---

A client tool search starts deciding as soon as its call is complete in the stream, instead of after the provider's terminal event. Ranking, the decision model and the integration lookup now overlap the rest of the response, which on fast models is often several hundred milliseconds, so the response settles and the next request starts sooner. The search result is the same: the decision reads the turn's search state but records nothing until its call is accepted, and a response that never completes leaves no trace of its search.
