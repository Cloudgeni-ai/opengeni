# Tool search

Agents with large tool catalogs see only a few tools up front and load the rest
with `tool_search`. An agent knows the task it has to do, not the words in a tool's
description, so search has to match meaning and still return the right tool in one
call. This page describes what a search does and how a deployment configures it.

## What a search does

1. **Names.** Tool names in the query or in `names` are resolved in every common
   form: the full model name, the published `server.tool` form, and `projects.search`,
   `projects_search` or `projects-search` for a tool its server calls
   `projects.search`. This includes long tool names whose model names are shortened
   digest aliases; a name that several shortened names could stand for is left to
   the selector rather than loading all of them. A query that is nothing but names
   loads them and stops there.
2. **Requests.** A query is split into its requests (semicolons or new lines) and
   each request into its sentences, so a second ask is not crowded out by matches
   for the first.
3. **Candidates.** Each sentence is ranked by keywords over the caller's authorized
   tools and, when the deployment has a document embedding model, by meaning. The
   two rankings are fused, and the sentences' rankings are interleaved into one
   candidate list (40 tools), plus tools a named family begins and tools a
   candidate's own description points to.
4. **Selection**, when a [decision model](decision-models.md) is configured. One
   call judges every candidate, with its full description, against the query, the
   separate requests and what this turn already loaded: will the agent need it to
   do what the query asks? That includes a tool a chosen tool needs called first,
   for example to find an id it requires. Every candidate judged needed is loaded,
   whatever the search's `limit`, which bounds only keyword results and listed
   suggestions. If none is, the most likely one is loaded anyway. When the choice
   was not clear, up to five next candidates are listed by name.
5. **Without a decision model**, or when it fails or has not answered within 8
   seconds, each request's best candidate is loaded together with the next ones
   from the same integration that score close to it (at least 0.7 of the best), up
   to three per request, and the remaining candidates are listed by name. A task
   usually needs a tool with its siblings (create a session, then message it), so
   one search brings them instead of one search each. A close match from another
   integration or connection is a rival reading of the request, not a sibling: it
   is listed, not loaded. A selection not answered within 2.5 seconds sends one
   identical request beside it; the first answer wins and the other is cancelled.
   Each fallback is counted in `opengeni_tool_search_selection_fallbacks_total` by
   reason (`deadline`, `rate_limited`, `provider_error`, `request_failed`,
   `invalid_answer`) and logged with its time and attempts.

A search never comes back empty while candidates exist. On native tool-search
routes (OpenAI and Codex), which can only carry loaded definitions, the candidates
not loaded follow the result as a short note. With a decision model, a repeated
search in the same turn lists candidates it has not listed before. Tools already in
the agent's tool list are reported as available rather than as unavailable.

When the person has several connected accounts that serve the same need (Gmail and
Outlook Mail, say), the first search or exact-name load in a turn that gives the
agent one account's tools names the others, so a request for "my email" checks
each. With several accounts of one connector, each tool's description starts with
the account it reaches; ranking reads past that line, and previews show the account
and then what the tool does.

## Configuration

| Capability | Setting | Without it |
| --- | --- | --- |
| Selection | The decision-model category (`OPENGENI_DECISION_MODEL_*`), see [decision models](decision-models.md). | The strongest few candidates per request are loaded and the others are listed. |
| Meaning ranking | The document embedding model Knowledge uses (`OPENGENI_DOCUMENT_EMBEDDING_*`, see [embedding](embedding.md)). There is no separate tool-search setting. | Keywords alone. |

Meaning ranking is off when the embedding provider is the local `deterministic`
stand-in, which carries no meaning, when it has no credential, and under
[EU-only inference](eu-only-inference.md) unless the embedding endpoint has a
residency record for the `knowledge.embeddings` side feature. Each worker process
computes its catalog's tool vectors once, in the background, and keeps them in
memory; until they are ready, and for any search where the query's embedding takes
longer than 1.5 seconds, ranking uses keywords alone. Only the query is embedded per
search. Embedding calls for tool search are not yet recorded as usage.

A selection reads roughly 10,000 to 20,000 input tokens. Give the decision model its
own deployment or quota, so tool search does not exhaust a rate limit shared with
other work.

## Measuring a deployment's catalog

The [tool search evaluation harness](../scripts/tool-discovery-eval/README.md)
replays a deployment's real authorized catalog against labelled scenarios and
compares the runtime's search with and without meaning ranking and a decision
model, reporting first-pick accuracy, recall, wrong tools loaded, latency and cost
per search, with a trace of every search.
