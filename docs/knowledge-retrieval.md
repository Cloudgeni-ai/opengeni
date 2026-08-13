# Agent Knowledge retrieval

This document is the canonical contract for the workspace-local agent Knowledge
read surface. It is a projection over authorized, ready Documents; it does not
create another durable store, a prompt-injection path, or behavioral authority.

Canonical implementation:

- wire envelope: `packages/contracts/src/knowledge.ts`
- authorization, ranking, fetch, and browsing: `packages/documents/src/index.ts`
- first-party agent tools: `apps/api/src/mcp/documents.ts`
- built-in tool allowlist: `packages/config/src/index.ts`

## Strict envelope, flexible content

Every returned record has a stable opaque id, kind, authority kind, source and
index provenance, active lifecycle state, honest quality signals, links, and
explicit projection-loss facts.
Current Document evidence is `sourced`; freshness follows the source update or
index time, while conflict remains explicitly `not_evaluated` until normalized
claim review is activated. The Markdown body, summary, topics, and source
metadata remain flexible so varied company information does not need one rigid
taxonomy, but the model-facing envelope is not unbounded: title, body, summary,
topic strings/count, source strings, metadata depth/item count/serialized bytes,
and link count have deterministic UTF-8/item limits. `projection.truncated` and
its sorted `fields` list identify every field that was shortened or omitted, so
the boundary never silently presents a partial value as complete. Metadata keys
are projected in stable lexical order. The agent projection deliberately omits personal subject ids,
ingestion workspace/base/file ids, and metadata about a linked record that was
not independently authorized. A source URI is copied only from the
already-authorized record and only within the Knowledge envelope's 8 KiB bound;
an oversized value is omitted rather than emitted as an invalid partial URI,
with `provenance.source.uri` recorded in the projection facts.

Documents and chunks are evidence, not instructions. Their contents cannot
activate a preference, policy, Skill, company profile, or Memory record.

## Discovery and traversal

The first-party Documents MCP exposes:

- `knowledge_search`: hybrid/vector/keyword ranking over authorized chunks;
- `knowledge_get`: exact fetch by a stable id returned by search or browse;
- `knowledge_browse`: cursor-bounded top-level Document discovery or the chunks
  of one authorized Document.

Agents search first and follow stable links; they do not need to crawl document
bases or folders. `knowledge_browse` topic/source filters are discovery hints,
not authority. Its opaque cursor is bound to the exact account, requesting
workspace, immutable initiating subject, parent, topic, and source filters.

The compatibility tools (`search_documents`, `knowledge_fetch`,
`fetch_document_chunk`, and `list_document_bases`) remain available for existing
callers, but new Knowledge navigation should use the three tools above.

## Permission-first reads

The immutable initiating human is bound by the MCP server; no tool argument can
replace it. Every path applies `account + requesting workspace + initiating
subject + agent_access` before a row can be ranked or returned:

1. search filters before vector/keyword ranking and limits;
2. search re-fetches every selected chunk before projection, so a concurrent
   revocation removes it from the response;
3. get performs a fresh exact-record authorization check;
4. browse rechecks the parent before listing children and filters every child;
5. following an internal link is an ordinary get/browse and rechecks authority.

An inaccessible parent returns no children and no title, source, or relationship
metadata. A cursor can only move within the already-authorized query; it never
widens access.

## Deliberately deferred

This no-migration slice does not make normalized scoped claims model-visible,
activate cross-workspace Personal authority, implement shared-session grants or
revocation fencing, persist Task-tree notes, or write durable logical-turn
selection receipts. Those require the staged tenancy/grant work and the
separate governed write/promotion lane. Until then, the Knowledge tools remain
explicit retrieval rather than automatic prompt composition.

The runtime's existing Skills capability already gives selected Skills an
always-visible bounded name/description index and lazily materializes the full
body only when `load_skill` is called. Knowledge retrieval does not duplicate
that descriptor catalog.
