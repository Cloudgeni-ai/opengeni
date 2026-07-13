# Contract decisions — reviewed and deliberately kept

Record tier (2026-07-03). An architecture review of the SDK, publishing, and
consumption surfaces flagged the items below; each was examined and **kept on
purpose**. This record exists so future reviewers (human or agent) see the
reasoning instead of re-flagging them. If circumstances change, overturn them
consciously — with a doc update, not silently.

1. **Event payloads stay `z.unknown()` in contracts.** Payloads carry
   provider-native shapes; full zod typing would be brittle theater against
   upstream drift. The real contract is the tolerant-reader projection in
   `@opengeni/react`, pinned by its golden event-grammar test suite. Emitters
   evolve additively; readers ignore what they don't know.

2. **No runtime API version negotiation.** The compatibility mechanism is the
   additive-within-a-major policy (architecture.md §3.10) plus tolerant readers
   on both sides, with `serverVersion` surfaced for clients that want to check.
   Negotiation machinery would add failure modes without adding safety at the
   current scale.

3. **API-side admission is local in embedded deployments.** The host owns the
   perimeter (its auth fronts the mounted router) and host business admission
   enters at the worker's entitlements port, where work actually starts. See
   embedding.md "Trust model".

4. **The engine self-mints internal tokens** (first-party MCP `ogd_`, stream
   tokens, NATS credentials) with its own secrets — they never leave the
   engine's trust domain, so a host token-issuer port would be coupling without
   security. Hosts protect the engine's secrets like their own signing keys.

5. **List endpoints return bare arrays.** The unfulfilled `PageInfo`/
   `paginated()` promise was removed from contracts rather than adopted; the
   events route's `after`/`before`/`limit`/`compact` cursor scheme is the
   deliberate exception, designed for its access pattern.

6. **Published manifests point at TypeScript source in-repo.** Workspace DX is
   source-first (Bun); the blessed release path rewrites entrypoints to `dist`
   and `workspace:*` to real ranges at publish, and a prepublish guard fails
   any bypass. Do not "fix" the committed manifests to point at dist.

7. **`@opengeni/core` is an engine-core, not a domain-core.** It keeps Hono's
   `HTTPException` and the server closure; embedders who want purity should use
   the REST API. Documented in the package README.

8. **Error envelope unification is deferred.** Auth's bare `{ error }` shape
   and route-level variance predate `ErrorEnvelope`; unifying is a breaking
   change worth batching into the next natural major, not worth its own break.

---

## Amendment (2026-07-13) — the principal model is a contract

9. **Membership authorizes people; credentials authorize themselves.** Decided
   after an incident: OPE-26's session-list rewrite required a
   `workspace_memberships` row for every caller, which 403'd every
   workspace-scoped `api_key:*` principal in production (embedder fleet views
   went blank platform-wide). The contract: `user:*` subjects are authorized
   exclusively through memberships (missing row = revoked); `api_key:*` and
   delegated-token subjects carry their own grants, and a membership row for
   them is optional roster/personalization state — never an authorization or
   liveness signal. Any new per-subject personal state must degrade gracefully
   for non-member subjects (default values on read, TTL-bounded persistence,
   membership-gated writes where cleanup depends on removal). New route-level
   behavior keyed on `grant.subjectId` must be exercised against all three
   principal personas (managed user, workspace-scoped API key, delegated
   token) before merge; see `docs/architecture.md` §10.
