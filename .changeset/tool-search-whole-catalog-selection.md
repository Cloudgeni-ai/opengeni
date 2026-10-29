---
"@opengeni/runtime": patch
---

With a decision model configured, an ambiguous tool search is now judged against the whole searchable catalog (up to 2,000 tools, best lexical matches first), not only the 40 best lexical matches. Agents often describe a step in other words than the tool's own text (another language, a synonym, several steps in one query), and the lexical shortlist then hid the right tool before any model saw it. Large catalogs are judged as parallel groups of 200, and when more than one group has picks, one final request over the strongest picks keeps only the best of them, at most five. Exact names and strong lexical matches still skip the model, and any failed request still recovers through lexical search. The tool-discovery decision eval now adds up usage across all requests of a search.
