# Explicit agent-directed durable writes

OPE-184 defines the bounded contract between an agent interpreting an explicit
human instruction and the canonical durable-learning router. It does not add a
knowledge store, persistence adapter, policy engine, natural-language
classifier, or production tool registration.

Canonical implementation:

- model/host boundary and public receipt contracts:
  `packages/contracts/src/explicit-durable-writes.ts`;
- pure command-to-router translation and receipt projection:
  `packages/core/src/domain/explicit-durable-writes.ts`;
- router conformance harness:
  `packages/core/test/explicit-durable-writes.test.ts`.

The only persistence seam remains OPE-183's `routeDurableLearning`. A future
agent tool must translate its bounded input with
`toExplicitDurableLearningRouterRequest`, call that router, and project its
response with `projectExplicitDurableWriteReceipt`. It must never call Memory,
Preference Registry, instruction-policy, company-profile, Documents/RAG, or an
attempt ledger directly.

## Model input versus trusted host binding

The model-visible command contains only:

- operation: remember or undo;
- explicit scope: personal, workspace, company, or `unspecified` solely to
  obtain a deterministic scope clarification;
- structured intent and exact content;
- bounded authority-native metadata such as preference stable key/title/summary
  or a correction target resource id.

The model never supplies account, workspace, organization, user, session,
authority grants, activation permission, learning-policy facts, source-message
eligibility, or the router attempt id.

The host binds the exact accepted turn before router invocation:

- one immutable attempt UUID reused by retries of that accepted tool call;
- the exact current session UUID;
- for remember, the source message id/version/content hash;
- OPE-183's frozen `DurableLearningAuthorityContext`, including the immutable
  initiating human and exact grants.

The binding fails closed if its session differs from the router context or no
immutable initiating human exists. A nested agent or service actor never
becomes personal authority; personal scope is constructed only as the frozen
initiating human's user scope.

## Deterministic routing matrix

The agent supplies structured intent after interpreting the conversation. The
translator maps it without another classifier:

| Intent | Canonical target |
| --- | --- |
| fact, decision, observation, history | Memory |
| preference, procedure, working method, skill guidance | Preference Registry |
| workspace charter, mandatory operating context, workspace goal | instruction-policy authority |
| company identity, mission, product, customer, goal, constraint | company-profile authority |

Scopes map as follows:

- personal → exact initiating-human user scope;
- workspace → current workspace scope;
- company → organization scope;
- unspecified → the router's `unspecified` scope, producing its immutable
  `SCOPE_REQUIRED` clarification receipt without invoking an adapter.

The translator always requests `origin=explicit_remember` and
`requestedAuthority=active`. An authorized explicit human command therefore
does not receive a redundant proposal/approval step. Activation remains subject
to the router's frozen `activate` grant; lack of authority is an immutable
rejection and never a silent downgrade to proposal mode.

Scope/intent combinations unsupported by the selected canonical authority are
not reinterpreted. For example, a company-scoped generic Memory fact is rejected
because Memory has no organization scope; the caller must clarify a company
profile intent or choose a narrower scope. Company-profile writes remain
`SURFACE_NOT_AVAILABLE` until OPE-185 installs that adapter. Preference metadata
requirements and every other authority rule stay owned by the router and the
selected authority.

Documents, connector payloads, and transcripts are deliberately absent from the
explicit remember intent enum. They remain Documents/RAG evidence and cannot be
promoted into active Memory, preferences, or policy through this command.

If the human's intended content kind is genuinely ambiguous, the agent must ask
for that clarification before issuing a remember operation. No attempt id is
allocated and no persistence action is accepted until the structured intent is
resolved. Once a command is accepted, all refusal, scope clarification,
authority routing, and persistence outcomes come from the OPE-183 router.

## Attempts, correction, retry, and rollback

The explicit command does not own an idempotency or audit ledger. Its trusted
binding supplies the OPE-183 `attemptId`; the router hashes the exact translated
request plus frozen authority context, reserves the attempt before adapter
execution, and returns the immutable receipt.

- Exact retry: reuse the same attempt id, command, source binding, and authority
  context; the router returns the original receipt and does not call an adapter
  twice.
- Changed retry: reusing the attempt id with changed input is
  `ATTEMPT_REUSED_WITH_DIFFERENT_INPUT`.
- Correction/supersession: a remember command may carry
  `replacesResourceId`; the selected authority owns its native immutable
  correction lifecycle.
- Undo: create a new explicit command and new attempt id that references the
  original write attempt. It translates to OPE-183 rollback and can invoke only
  the original receipt's authority and opaque rollback token. The rollback
  attempt's immutable actor, initiating-human, session, reason, and target
  attempt are its audit provenance; OPE-183 does not invent a second evidence
  field for rollback.

The public explicit-write receipt includes outcome, decision and reasons,
destination, resolved scope/authority, concise saved-content summary, exact
resource identity/version, effective boundary, inspection coordinates, undo
support, attempt/input hash, and source evidence references. It intentionally
does not expose the authority-owned rollback token. Undo re-enters the router by
target attempt id; no public token or direct adapter call is a valid path.

## Production wiring boundary

This contract/test slice intentionally does not register first-party MCP tools,
change session tool policy, add API routes, install adapters, create migrations,
or claim that writes are live. Production integration may proceed only after
the OPE-183 attempt ledger and canonical authority adapters are stable on the
target branch. That integration must:

1. authorize the exact accepted session/tool call;
2. derive the immutable initiating human and grants from the accepted turn, not
   session creation, current membership alone, or model input;
3. allocate/reuse one attempt id at the accepted tool-call boundary;
4. bind exact eligible source-message evidence;
5. call `routeDurableLearning` exactly once through a durable integration;
6. return only the bounded public projection;
7. emit transparent audit/timeline evidence from canonical attempts and
   authority lifecycle events, not a parallel log;
8. preserve `next_accepted_attempt` as the normal active knowledge boundary.

OPE-147 owns learning-policy resolution. OPE-185 owns company-profile storage
and prompt composition. Neither belongs in this contract or translator.
