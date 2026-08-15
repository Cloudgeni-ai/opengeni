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
Top-level cursors retain their v1 compatibility identity. Child-content cursors
are v2 and additionally bind the Document's monotonic indexing-completion
revision; a successful reindex invalidates an older cursor instead of silently
mixing chunk versions.

Document records expose an authorized `contents` link to their first chunk;
chunks expose their `parent` plus authorized `previous`/`next` neighbors. These
links contain only opaque stable ids. A linked title, source, quality fact, or
body is never copied into the originating record, and following any link is a
fresh `knowledge_get`/`knowledge_browse` authorization check. Revoking the
document therefore removes both its records and its traversal surface.

### Bounded search selection

Search retrieves a bounded surplus from each already-authorized vector/keyword
arm. The per-signal relevance floors are applied to that union before the final
50-candidate window, preventing incidental vector neighbors from evicting valid
keyword hits. SQL arms and the merged ranking use the opaque chunk id as their
last tie-break, then one deterministic final selection runs after the exact-row
recheck:

1. a result must have vector score `>= 0.52` or normalized keyword score
   `>= 0.01` (`any_signal`); incidental vector neighbors below the floor are
   omitted;
2. freshness is classified at response construction as `current` (at most 90
   days), `aging` (at most 365 days), or `stale`; current/aging evidence receives
   a small `0.02`/`0.01` ordering adjustment while stale evidence remains
   retrievable with no boost;
3. exact textual content (title, body, summary, and topics) is deduplicated,
   retaining the highest-ranked authorized source and reporting the number of
   duplicates; source/provenance metadata is not used to manufacture a second
   copy of identical model-visible content;
4. the caller limit is applied, then whole records are removed from the tail
   until the complete serialized response is at most 64 KiB.

Every response reports the bounded ranked and rechecked candidate counts,
recheck/floor/dedupe/limit/response-budget omissions, exact serialized UTF-8
bytes, and a deterministic byte-based token estimate (four bytes per estimated
token). The token value is a budget fact, not a claim about a provider-specific
tokenizer. Counts describe only candidates already inside the authorized
bounded window, so they cannot reveal inaccessible rows. Trust remains
`sourced` and conflict remains `not_evaluated`; those honest neutral quality
facts do not receive a hidden score adjustment.

Browse applies the same 64 KiB complete-serialized-response boundary. Whole
tail records remain behind the returned cursor, so following the cursor cannot
skip a budget-omitted record. If one complete record alone cannot fit because
JSON escaping expands otherwise bounded fields, browse returns one explicit
compact discovery projection and the agent may use `knowledge_get` for the full
freshly authorized record. Browse reports exact response bytes, the same
deterministic four-byte token estimate, budget omissions, and whether that one
record was compacted.

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
5. structural link ids are selected under the same RLS context as the visible
   record, without linked titles or source metadata;
6. following an internal link is an ordinary get/browse and rechecks authority.

An inaccessible parent returns no children and no title, source, or relationship
metadata. A cursor can only move within the already-authorized query; it never
widens access.

### Google Drive object authority

Migration `0243_google_drive_object_acl_authority.sql` adds an additional
provider authorization predicate for any file bytes protected by Google Drive.
It is evaluated before search ranking and again on every selected search row,
exact get, browse parent/child, compatibility fetch, and file-byte consumer.
An ordinary Document or another allowed Drive object that shares those bytes
cannot override one denied, expired, stale, disconnected, scope-revoked, or
otherwise invalid Drive object: every historical Drive object protector must
still resolve to its current version and fresh eligible evidence for the exact
initiating subject.

Evidence is append-only and binds the current source/object/version, provider
revision, sync and lifecycle generations, index obligation, and subject-owned
Google connection version. Persisted ACL principals are domain-separated
SHA-256 hashes rather than plaintext permission ids, emails, or domains.
Unsupported group membership fails closed. Starting an ACL refresh clears the
active evidence pointer and agent access before provider I/O, so stale evidence
cannot remain readable while the refresh is incomplete.

An authorized Google Drive record may carry a bounded provider citation with
external object/version/revision facts, Drive id, deep link, ACL revision, and
authorization timestamps. The citation function invokes the same current
authorization predicate and exposes neither connection UUIDs nor principal
identities; denial returns no record rather than a citation without authority.

## Explicit retrieval boundary

Normalized scoped claims are not yet model-visible, and cross-workspace
Personal/Organization authority remains behind the staged tenancy/grant work.
The accepted-logical-turn Company Brain receipt deliberately does not select or
inject Knowledge records: these tools authorize and fetch on demand, and their
completed tool results already enter canonical session history. The receipt
only freezes bounded legacy workspace-Memory candidates and composition facts;
it cannot turn Documents or RAG evidence into standing prompt state.

The runtime's existing Skills capability already gives selected Skills an
always-visible bounded name/description index and lazily materializes the full
body only when `load_skill` is called. Knowledge retrieval does not duplicate
that descriptor catalog.
