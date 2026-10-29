---
"@opengeni/runtime": minor
"@opengeni/documents": patch
---

Tool search finds tools by meaning and loads everything a search asks for. When the deployment has a document embedding model, each request in a query is ranked by meaning as well as keywords, and the rankings are fused into the candidate list; tool vectors are computed once per process. With a decision model, every search that is not purely tool names is judged over those candidates, every tool judged to belong to the requested actions is loaded without a fixed cap, and the next candidates are listed when the choice is unclear. Without one, the best candidate for each request is loaded and the others are listed on every route, so a search never comes back empty while candidates exist. The keyword strong-match shortcut past the decision model is removed, a decision model gets 5 seconds before search continues without it, and a name written with a dot or underscores now resolves to the one shortened digest alias it denotes instead of every alias that shares its prefix.
