---
"@opengeni/jev": minor
"@opengeni/decisions": minor
"@opengeni/worker-bundle": minor
---

New opt-in `code_grep` agent tool (`OPENGENI_CODE_SEARCH_ENGINE=grep`). The model passes the ripgrep patterns it would otherwise run one by one; the tool runs them in parallel, widens each hit to its enclosing function or block, and has the decision model keep only the excerpts relevant to the model's question, stopping early once they answer it. It returns those excerpts plus a compact list of the other matching files. With `OPENGENI_CODE_GREP_JUDGE=off`, or when the decision model fails, it returns the same excerpts in match order, cut to the same size. `OPENGENI_JEV_MAX_QUESTIONS_PER_REQUEST` sets the question cap for a Jev-compatible provider with a smaller cap than Jev, and decision models now expose that cap so callers batch to it.
