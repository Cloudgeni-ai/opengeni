# Tool approvals

An account's explicit Allow, Ask or Block choice wins over a tool's recommended
default. This is one policy decision, independent of access to the workspace,
account, provider scopes and current execution attempt. An approval never repairs
missing access. There is no additional host, embedder or organization policy floor.

## Ownership and compatibility

| Surface | Owner and meaning |
| --- | --- |
| Canonical decision and settings | `packages/db/src/connector-action-policy.ts`; most specific exact selector, conflicting ties Block, then recommendation. Settings project the same snapshot and report conditional differences as Mixed. |
| Registered action selector | `packages/contracts/src/tool-policy.ts`; executable schema determines recognized actions. Arbitrary argument text cannot select an easier policy. |
| `requireApproval`, `approvalMode`, provider annotations | Compatibility inputs and recommended defaults, never an extra gate after an explicit choice. |
| API Integration `autoApprovedTools` | Compatibility adapter to common preferences. Omission preserves choices. Explicit values replace applicable legacy exemptions. Changed account or executable meaning resets prior Allow to Ask with a visible notice; harmless description changes preserve it. |
| Model MCP and Codemode | The same attempt environment and connector preparation/begin/completion lifecycle. Standalone adapters without the lifecycle retain their safe approval-required failure. |
| Workspace HTTP gateway | The same decision resolver; existing one-use approval capability stays bound to exact caller, payload and authority. |
| External MCP | Tools that might ask remain unavailable without a verified human approval round trip. No blanket approval token is synthesized. |
| Human-input and learning settings | Separate product behavior. Requesting a person's answer and publishing learned instructions are not connector permission defaults. |

Saved preferences activate when work next starts or resumes. A prepared action
keeps its original decision and immutable content. Live access checks remain in
force. Reset is an explicit null preference; UI saves include the observed
revision and refuse concurrent overwrites. Groups change only the tools shown;
the connector default also governs newly discovered tools.

## Durable programmatic calls

A capable Codemode client negotiates durable approval, submits an operation ID,
and receives a compact waiting handle. Arguments remain in protected storage.
Waiting releases the execution claim and dispatcher capacity. The ordinary human
decision transaction and wake outbox resume the same turn; a current authorized
attempt adopts the exact operation after checking its executable identity.
Original attempt and catalog references never change. Recovery joins tool
preparation on use: the dispatcher reads the turn's journal first and waits for
full tool preparation only when an unfinished durable operation must resume, so
every other turn keeps the eager-only first-request barrier.

Approval resumes a stored operation, not a JavaScript stack. Persist a complete
selection and chunk plan before submitting changes. Each chunk has its own
operation ID and result. Reuse handles to observe outcomes; never reconstruct
arguments from model context. See the [Codemode client](../packages/codemode/README.md).

Pause and pending interruption fences prevent new effects. Terminal cancellation
cancels unstarted operations. Once execution starts, interruption or worker loss
preserves the execution marker and reports unknown outcome; it never blindly
replays. Rejected or changed operations do not execute. A continuation's terminal
receipt and timeline output commit atomically under the session activity gate.

Older clients do not receive an unsupported waiting state. They retain a safe
approval-required error. Native clients, the managed CLI/module and worker must
be released together; the release-owned client is installed into warm sandboxes.

## Portable review

`ToolActionReview` contains versioned facts, status, permitted responses and a
reason from the saved policy. `getToolActionReview` and `getToolReviewDetails`
require ordinary session access. Details are bound to the saved action digest,
not a new provider query. The shared React components supply pending review,
receipts and paginated details. Web owns navigation, not a separate renderer.

A waiting action can always be declined. An older request whose saved
arguments cannot be recovered offers Decline only: it cannot be approved, but
declining resumes the turn so the session is never stuck. A Block reports its
own reason, including a conflict between two equally specific settings.

Primary fields are bounded summaries; the full selection remains accessible in
pages of 25 (at most 50). Long text is split into 4,000-character parts. Unusually
long object keys use compact indexed paths and expose their complete saved name
and value. Credential fields remain protected. Ordinary selection summaries stay
below 32 KiB even for 10,000 IDs; detailed email bodies and many compound effects
can legitimately require larger protected detail pages. Consequences must not be
silently omitted to meet a display target.

Arguments and review context each have a 4 MiB limit. Codemode results have a
16 MiB limit, and a turn may hold 128 unfinished programmatic operations. Existing
session retention owns these rows. Do not independently prune execution markers
while retaining resumable handles: doing so would discard replay protection.

Slack uses these same saved facts only in an authorized private bot conversation.
Shared or unproven audiences receive a task link. Large reviews also direct the
person to full details. Delivery bytes are stable for the original event even
after a decision; signed button handlers recheck the actor, channel, access and
canonical request. A stale button cannot execute twice.
Existing pre-upgrade Slack post intents retain their original renderer only for
repair after a ledger digest conflict. Repair reuses the same operation identity;
it never posts a replacement under a fresh identity.

## Diagnostics

Protected request and operation records retain policy source, immutable digest,
original and execution attempts, decision and outcome. General metrics never
contain arguments, account labels, subjects or arbitrary tool names.
`opengeni_tool_approval_transitions_total{outcome,source}` records bounded policy
and continuation observations; `opengeni_tool_approval_wait_seconds{outcome}`
separates stored waiting time from execution. These are observational counters,
not an exactly-once financial or audit ledger. Existing MCP phase traces correlate
opaque call identities and provider access failures independently. Observer
failure cannot change execution.

## Rollout

The Codemode continuation and legacy API preference migrations are maintenance
cutovers. Drain all old API and worker database writers, including every declared
runtime login, before migrating. The migration refuses an active writer. Provision
the target database roles, then start matching API, workers, web and native runtime
artifacts. Existing pending requests retain their original decisions; migration
does not execute them.

The policy-source default and additive review-detail columns are rolling changes
individually, but do not make the complete release safe for mixed workers. After
maintenance activation, recovery is forward-only with a compatible artifact set.
Do not restart a worker that cannot understand waiting operations or the new
policy semantics. Verify fresh installation, populated upgrade, restricted-owner
backfill and current-main migration ordinals before release. Follow the ordinary
[deployment procedure](deployment.md).
