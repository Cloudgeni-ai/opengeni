# Search loads the strongest few matches

Without a decision model, `tool_search` loaded one tool per request, so a task
that needs a tool and its siblings (create a session, then message it; prepare a
Knowledge save, then save) spent one model round trip per sibling, and a tie
loaded only one guess. A search now loads each request's best match and the
next matches that score close to it, up to three per request; another
connection's copy of the same operation is not loaded with it. The runtime
mechanics sentence and the generic `tool_search` description now say "the
strongest few matches" instead of "the strongest match" (+6 bytes each; the
native description already said "matches"). The sentence edit is recorded on
its original line in `2026-11-11-legacy-sentence-edits.md`.
