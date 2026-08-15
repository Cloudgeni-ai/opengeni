# Agent Knowledge retrieval

This document is the canonical contract for the permission-first agent Knowledge
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

The immutable initiating human and exact session attempt are bound by the MCP
server; no tool argument can replace either. Every path applies `organization +
requesting workspace + initiating subject + agent_access` before a row can be
ranked or returned:

1. search filters before vector/keyword ranking and limits;
2. search re-fetches every selected chunk before projection, so a concurrent
   revocation removes it from the response;
3. get performs a fresh exact-record authorization check;
4. browse rechecks the parent before listing children and filters every child;
5. following an internal link is an ordinary get/browse and rechecks authority.

An inaccessible parent returns no children and no title, source, or relationship
metadata. A cursor can only move within the already-authorized query; it never
widens access.

### Three-scope Document authority

Organization Documents are available throughout their organization. Workspace
Documents are available only in their authority workspace. New personal
Documents use a common organization-user authority: their physical workspace is
immutable ingestion/indexing provenance, while human retrieval follows the
exact owner across that owner's currently accessible workspaces in the same
organization. Losing access to the origin workspace removes its workspace
knowledge but does not remove the owner's personal Document. Legacy personal
Documents remain origin-workspace anchored and are never inferred into the new
authority. Document-scoped original-file reads and downloads atomically resolve
this same effective Document boundary, current owner authority, provider ACL,
and only the immutable origin file; generic file access does not become portable.

Personal ownership is not an agent grant. When an exact turn attempt is
admitted, the database freezes only ready, agent-enabled personal Documents
covered by a matching `document.read` once/session/always grant for the target
workspace, session visibility, and authority epoch. Workspace-shared grants
require the common explicit shared-output acknowledgement. Every later read
rechecks the exact attempt and interruption state, current target-workspace
access, organization membership revision, resource generation, grant generation
and expiry, and Document status. Calls without an exact attempt omit personal
Documents. Revoking any fence removes access immediately; a permission granted
after admission cannot widen the already-running attempt.
The sole compatibility lane is a legacy null-authority personal Document: an
agent may read it only for the exact initiating subject in its origin workspace.
It cannot follow that subject to another workspace, and common-authority
personal Documents never bypass the admitted snapshot.

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

The three-scope Document authority makes authorized organization, workspace,
and personal records available through explicit retrieval; it does not turn
normalized scoped claims into standing prompt state, persist Task-tree notes,
or enter the separate governed write/promotion lane. The accepted-logical-turn
Company Brain receipt deliberately does not select or inject Document records:
these tools authorize and fetch on demand, and completed tool results enter
canonical session history. The receipt freezes only bounded legacy
workspace-Memory candidates and composition facts. It cannot change
`knowledge_memories`, structured preferences, company profile, instruction
policy, or prompt composition.

The runtime's existing Skills capability already gives selected Skills an
always-visible bounded name/description index and lazily materializes the full
body only when `load_skill` is called. Knowledge retrieval does not duplicate
that descriptor catalog.
