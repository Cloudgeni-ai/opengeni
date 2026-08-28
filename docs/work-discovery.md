# Advisory work discovery and durable work claims

OpenGeni can surface compact, provider-neutral evidence that another authorized
session may be working on related material. The feature has two parts:

- **work discovery** searches bounded session titles, active goals, and typed
  work claims after ordinary authorization and host narrowing; and
- **durable work claims** let an exact live agent attempt publish structured
  evidence about an external subject such as a repository, pull request,
  artifact, release, or CI run.

The result is advisory only. It is not ownership, a reservation, a lock, a
lease, an instruction, a control decision, or an access grant. Every projection
therefore carries the literal facts `advisoryOnly: true` and
`noAdditionalAccess: true`.

Canonical implementation:

- contracts and bounds: `packages/contracts/src/work-claims.ts`;
- persistence, exact-attempt mutation, and lifecycle settlement:
  `packages/db/src/work-claims.ts`, `packages/db/src/work-claims-schema.ts`, and
  the work-claim migrations in `packages/db/drizzle/`;
- permission-first discovery query: `packages/db/src/index.ts`;
- first-party MCP and HTTP topology surfaces: `apps/api/src/mcp/server.ts` and
  `apps/api/src/routes/sessions.ts`;
- client surface: `OpenGeniClient.listAgentTopology` in
  `packages/sdk/src/client.ts`; and
- human presentation: `apps/web/src/components/related-work-advisory.tsx`.

## Non-negotiable boundaries

1. A claim grants no access. A caller may receive only sessions it could
   already list through the normal workspace, private-session, Slack-private,
   exact-attempt, and optional embedding-host authorization rules.
2. Authorization and host scope are applied before lifecycle filters,
   matching, ranking, counts, pagination, or ancestor expansion.
3. Discovery never searches `initialMessage`, session instructions, resources,
   tools, files, repositories, full events, or model history.
4. Claims are non-exclusive. Two sessions may actively claim the same exact
   typed subject, including with the same role.
5. No automatic action follows from a match. Discovery does not pause, cancel,
   reassign, merge, steer, message, or otherwise mutate either session.
6. Searching is optional. An agent is not required to search before starting
   work, and a claim mutation does not require a prior search.
7. Claim provenance and version are evidence, not authority. They must never be
   used as a credential or permission predicate.

See [`agent-session-authority.md`](agent-session-authority.md) for the broader
peer-session authorization policy.

## Permission-first query order

Every discovery traversal follows this conceptual order inside one
workspace-RLS transaction:

1. Authenticate the caller and require the surface's ordinary permission.
2. For a live agent attempt, reconstruct and validate the exact current
   session/turn/attempt/generation authority.
3. Resolve an optional embedding host's complete list scope. A host may narrow
   the result to exact roots/sessions; it cannot widen OpenGeni access.
4. Apply workspace tenancy, session visibility, Slack-private, host scope,
   status, `activeOnly`, recency, root, parent, activity-revision, and snapshot
   fences into a materialized authorized session set.
5. Match only inside that authorized set.
6. Rank, count, and keyset-page the authorized matches.
7. Load bounded claim, goal, control, queue-count, and tree projections only for
   the returned page.
8. When relevance results need ancestor labels, authorize the ancestors first
   and then return only those authorized labels.

The `total` field is therefore the count of authorized, prefiltered matches. A
hidden session cannot influence a count, score, explanation, cursor, overlap
indicator, or ancestor path.

## Search corpus and ranking

### Exact typed subject

An exact subject filter contains:

```ts
{
  namespace: string;
  type:
    | "repository"
    | "branch"
    | "pull_request"
    | "issue"
    | "artifact"
    | "release"
    | "ci_run"
    | "other";
  canonicalKey: string;
}
```

OpenGeni normalizes the namespace to canonical lowercase text, canonicalizes
the key's Unicode/outer whitespace, hashes the tuple with separators, and
matches the digest plus the original namespace/type. This path never treats a
display label as identity. Exact-subject matches rank before all text matches
and project `class: "exact_subject"`, `field: "subject"`, and
`scoreBand: "exact"`.

An exact subject and a text query cannot be combined in one request.

### Text query

Text discovery normalizes Unicode, trims outer whitespace, collapses internal
whitespace, rejects control characters, and accepts at most 200 characters. It
searches, in order:

1. the durable semantic session title;
2. the active durable goal text; and
3. active typed claim keys and display labels, or recently settled claims when
   an explicit recency window includes them.

The opening prompt and every raw `initialMessage` remain outside this corpus.
The optional latest-message preview is a separate monitoring projection and
does not participate in matching or ranking.

The public explanation order is stable:

| Priority | Match class | Matched field | Public score bands |
| --- | --- | --- | --- |
| 1 | `exact_subject` | `subject` | `exact` |
| 2 | `title` | `title` | `exact`, `strong` |
| 3 | `goal` | `goal` | `exact`, `strong` |
| 4 | `fuzzy` | `claim_key`, `claim_label` | `exact`, `strong`, `related` |

Within one class, exact normalized equality precedes prefix equality, which
precedes full-text lexical matching. Active claims precede recently settled
claims. Remaining ties use the session activity revision, update timestamp,
and UUID for deterministic keyset order.

`fuzzy` is a stable public explanation class for lexical claim-key/label
matching. It does **not** currently promise typo-tolerant edit distance,
trigram similarity, semantic embeddings, or provider-specific alias expansion.

## Discovery filters and cursors

The first-party `sessions_list` tool and the agent-topology HTTP/SDK surface
support the same core filters:

- `query` or one exact `subject`;
- `statuses`;
- `activeOnly`;
- `recentHours` (at most one year);
- `rootSessionId`;
- `parentSessionId`, including exact root-only `null`;
- `limit` from 1 through 100;
- `claimLimit` from 1 through 8; and
- an opaque cursor.

The MCP tool also retains chronological `createdAt` / `updatedAt` traversal and
the activity-revision `updatedAfter` incremental mode. A relevance request uses
relevance order automatically.

Relevance cursors bind all normalized filters to a SHA-256 digest and freeze a
workspace activity-revision snapshot. Reusing a cursor with another query,
subject, lifecycle filter, root/parent filter, or recency window fails instead
of silently changing the result set. Chronological cursors cannot carry
relevance fields, and relevance cursors cannot be downgraded into chronological
ones.

The MCP projection is compact by construction:

- at most 100 session rows;
- at most 8 claims per row (default 4), with `claimsTruncated` when more exist;
- titles, goals, blocker labels, and optional latest-message previews are
  character-bounded;
- optional latest-message text shares a 16 KiB aggregate preview budget; and
- the complete serialized page is capped at 128,000 bytes, with continuation
  through `nextCursor`.

The projection never returns session instructions, resources, tools, MCP
metadata, repository credentials, files, full events, or history bodies.

## Durable work claims

A claim head records:

- provider-neutral subject identity (`namespace`, `type`, `canonicalKey`);
- optional bounded display label;
- role: `working`, `reviewing`, `monitoring`, or `delivering`;
- state: `active`, `released`, `superseded`, or `stale`;
- monotonic revision;
- provenance;
- optional typed version identity;
- observed, created, updated, and settlement timestamps; and
- the owning session and root session.

The current bounds are deliberately small: at most 64 active claims per
session, 64 bytes for a namespace, 512 bytes for a canonical key, and 256 bytes
for a display label or version value. Control characters and non-canonical
Unicode/outer whitespace are rejected.

Claim fields are authorized workspace metadata, not a secret store. Use stable
public identifiers and concise labels only; never place credentials, tokens, or
other secret values in a subject key, label, version, or provenance field.

### Mutation authority

The first-party MCP tools `work_claim_upsert` and `work_claim_release` require:

- `sessions:control`;
- a session-bound, exact signed agent attempt;
- the exact current logical turn and execution generation; and
- a current attempt in a mutable running state with no active interruption.

The application role has no direct claim-table DML. Mutation goes through
PUBLIC-revoked `SECURITY DEFINER` routines that mint a transaction-local
capability, write the head and immutable revision together, and remove the
capability before commit. FORCE RLS remains active for the restricted
application role and the production non-bypass migration owner.

### CAS and idempotency

Every mutation supplies a fresh `operationId` and an `expectedRevision`:

- `expectedRevision: 0` creates a new active claim;
- refreshing an active claim requires its exact positive revision; and
- release requires the exact claim id and revision.

An exact retry of one operation replays the immutable receipt. Reusing an
operation id with different input conflicts. If a worker is replaced while the
same logical turn recovers, the successor attempt may replay the predecessor's
operation receipt, but a stale attempt cannot create a new mutation or advance
the head.

### Lifecycle settlement

Claims do not keep a session alive and do not control its lifecycle. Instead,
terminal lifecycle changes settle any active evidence:

- goal completion releases active claims with reason `completed`;
- session cancellation releases them with reason `cancelled`;
- session failure marks them stale with reason `failed`; and
- an explicit release records its supplied bounded reason.

Goal pause/resume and session Pause do not release claims. A settled claim is
never rewritten back to active; a later attempt creates a new claim head with a
new id. Immutable revisions retain the old lifecycle evidence.

## Consumer presentation

Each session's `relatedWork` / `workDiscovery` projection contains:

```ts
{
  claims: WorkClaimDiscoverySummary[];
  claimsTruncated: boolean;
  match: {
    class: "exact_subject" | "title" | "goal" | "fuzzy";
    field: "subject" | "title" | "goal" | "claim_key" | "claim_label";
    scoreBand: "exact" | "strong" | "related";
    claimId: string | null;
  } | null;
  possibleOverlap: boolean;
  advisoryOnly: true;
  noAdditionalAccess: true;
}
```

The stock topology UI uses “Possible related work” and “Possible overlap,”
shows the bounded match explanation, role/state/version/provenance/freshness,
and states that the evidence does not reserve work, transfer ownership, or
authorize another session.

Consumers must preserve that meaning. A useful UI may offer a user-driven link
to an already-authorized session, but it must not present a claim as “owned,”
“locked,” “assigned,” or “safe to control.”

## Rollout and rollback

Four independent settings govern the rollout:

| Setting | Default | Effect |
| --- | --- | --- |
| `OPENGENI_WORK_DISCOVERY_ENABLED` | `true` | Enables query/exact-subject discovery and claim evidence in compact projections. When false, relevance requests fail explicitly while ordinary browsing remains available without claim reads. |
| `OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED` | `true` | Registers the exact-attempt claim mutation tools. When false, existing evidence stays readable and lifecycle settlement remains active. |
| `OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED` | `true` | Controls the topology response's human-presentation decision. It does not change API authority or stored evidence. |
| `OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED` | `false` | Reserved rollout marker. No automatic nudge producer is shipped; setting this alone must not create mandatory searches or cross-session actions. |

A conservative deployment can stage the feature as follows:

1. Apply the additive rolling migrations and deploy the new API/web code with
   all four settings explicitly false.
2. Enable claim mutations to collect real evidence while discovery remains
   hidden.
3. Enable work discovery for selected API/MCP consumers and inspect latency,
   result counts, response sizes, and match-class distribution.
4. Enable human advisories after reviewing the presentation in the target UI.
5. Keep automatic nudges false until a separately reviewed implementation,
   labeled precision evaluation, operator runbook, and user-control design
   exist.

Rollback is flag-only and forward-compatible:

- disable human advisories first to hide the UI without affecting reads;
- disable discovery to reject relevance requests and skip advisory claim reads
  on ordinary lists;
- disable claim mutations to stop new agent-authored evidence; and
- leave the additive tables, immutable revisions, lifecycle triggers, and
  indexes in place.

Do not delete claim evidence, roll back the migration ledger, or mutate claim
heads directly as a feature rollback.

## Observability and alerting

Work-discovery telemetry uses only fixed, low-cardinality labels. It never
records workspace/session ids, query text, subject keys, titles, goals, claim
labels, versions, or provenance.

Metrics:

- `opengeni_work_discovery_requests_total`
  (`surface`, `mode`, `outcome`, `authorization_scope`);
- `opengeni_work_discovery_duration_seconds` with the same labels;
- `opengeni_work_discovery_results` (`surface`, `mode`);
- `opengeni_work_discovery_response_bytes` (`surface`, `mode`);
- `opengeni_work_discovery_overlap_results_total` (`surface`, `mode`);
- `opengeni_work_discovery_matches_total`
  (`surface`, `mode`, `match_class`); and
- `opengeni_observability_observer_errors_total{observer="work_discovery"}`.

Observability failure is isolated from product behavior.

Recommended initial alerts are operational, not semantic:

- sustained non-disabled error ratio above the deployment's API baseline;
- p95 duration approaching the 2-second benchmark gate;
- response bytes approaching the 128,000-byte MCP envelope;
- repeated work-discovery observer errors; and
- a sudden latency or result-count shift after a rollout/configuration change.

Do not alert on a particular overlap rate or match class without a labeled
product baseline; those values depend on real workspace behavior.

## Performance and evaluation evidence

The reproducible harness is `scripts/bench-work-discovery.ts`, with the labeled
fixture in `scripts/fixtures/work-discovery-eval.json`.

It verifies:

- title → active goal → claim ordering for one text query;
- exact-subject matching;
- exclusion of an `initialMessage`-only session;
- authorization scope before counts;
- literal advisory/no-access fields;
- exact synthetic corpus counts, including one immutable revision per filler
  claim;
- p50/p95/p99 latency and serialized response bytes; and
- valid plans using the title, active-goal, claim-text, and exact-subject
  indexes.

Functional reads and timing run as the restricted `opengeni_app` role under
FORCE RLS. The receipt separately captures an application-role authorization
plan and admin-only physical matching-index plans. The latter isolates index
fitness from PostgreSQL RLS security-barrier pushdown; it is not used to claim
that the functional request bypasses RLS.

Run locally against the repository's real PostgreSQL fixture:

```bash
OPENGENI_EVIDENCE_DIR=.agent/evidence \
  bun run bench:work-discovery -- --sessions 1000 --samples 20

OPENGENI_EVIDENCE_DIR=.agent/evidence \
  bun run bench:work-discovery -- --sessions 10000 --samples 20
```

The harness fails above 2,000 ms p95 for any read mode, above 128,000 response
bytes, on a labeled-evaluation mismatch, on corpus drift, or when an expected
index is absent from its matching plan. Operators may set stricter environment
thresholds for their hardware.

### Baseline retained on August 27, 2026

Environment: Bun 1.4.0, PostgreSQL 17.11 with pgvector 0.8.6, Linux x64. Each
run used three warm-up passes. The 1,000-session receipt used five measured
samples; the 10,000-session receipt used twenty.

| Corpus | Text query p95 | Exact subject p95 | Browse p95 | Text bytes | Exact-subject bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 sessions; 997 active goals/claims/revisions | 47.26 ms | 14.08 ms | 16.64 ms | 3,771 | 1,756 |
| 10,000 sessions; 9,997 active goals/claims/revisions | 363.32 ms | 42.45 ms | 61.99 ms | 3,771 | 1,756 |

Both runs passed the labeled evaluation, corpus assertions, response limits,
and these physical index assertions:

- `sessions_discovery_title_fts_idx`;
- `session_goals_discovery_active_text_fts_idx`;
- `session_work_claims_discovery_text_fts_idx`; and
- `session_work_claims_subject_state_idx`.

These numbers are a reproducible development baseline, not a production SLO or
a capacity claim for arbitrary hardware, tenancy distributions, or query mix.