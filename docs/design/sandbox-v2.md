# Sandbox v2

Status: implementation in progress; disabled by default. Legacy sessions continue
on the existing stack. Provider qualification is separate from this design.

Start with the [research and implementation handoff](sandbox-v2-handoff.md) for
the code map, provider comparison, validation instructions and remaining work.

## Target

One group owns one durable provider machine. The machine is the workspace;
OpenGeni does not build another routine backup, archive or rotation subsystem.
Providers may preserve processes when suspended; disk continuity is required,
process continuity must be observed. Connected Machines keep their existing
ownership and execution path.

The control plane owns session authorization, accepted work, exact attempts,
machine demand, transition identity and operation receipts. The provider owns
compute and storage. A small `opengeni-run` binary owns local command execution
and its on-disk journal. Ordinary provider command APIs reach the binary; managed
machines need no enrollment or persistent connection to the application bus.

## Simplification boundary

The journal replaces command retry bookkeeping. A durable provider machine
replaces routine workspace capture, archive export/import, restore verification
and pre-expiry rotation. These are separate capabilities: adding the journal to
an ephemeral machine does not make its filesystem durable. A native snapshot API
alone is insufficient if the application still has to schedule captures, fence
writes, retain snapshot pointers and handle rollback as its normal lifecycle.

V2 must preserve accepted work, tenant and attempt authorization, physical writer
retirement, command ownership and output receipts. Those are application semantics;
removing archive machinery does not remove them. Idle demand also remains: network
inactivity cannot distinguish a detached build from an unused machine. Native
auto-wake, background holds and process-restarting services must obey that demand
and must never replay an old one-shot journal operation.

For self-operated deployments, qualify an existing complete fleet control plane
and its native durable storage. Placement, admission, host provisioning, image
distribution, authenticated ingress/egress, node and disk fencing, upgrades,
observability and whole-fleet cost are operating requirements. A small backend
adapter or a working isolated runtime does not supply those systems. Do not grow
the local Docker adapter into a homemade scheduler, storage or ingress platform.

Measure the eventual removal against the actual dependency graph. Legacy lifecycle
modules also contain shared functionality; a file's line count is not a promise
that the whole file can be deleted. During the flag rollout both implementations
remain in the tree. Remove obsolete modules/tables only after all legacy groups
have migrated and their shared responsibilities have a tested owner.

## Coexistence

- New admission requires both the deployment flag and explicit workspace opt-in,
  plus a server-qualified adapter for the selected backend.
- Persist the engine selection on the sandbox group before creating anything.
  Children inherit their group's selection.
- Legacy and v2 admissions share one immutable engine-claim row and the same
  admission lock. Its unique constraint remains authoritative under stale repeatable
  read snapshots. Deleting a cold legacy lease does not erase its engine claim.
- Flag changes affect new admission. They never reinterpret an existing v2
  machine as a legacy lease, or send its command handles to a different engine.
- Migrate an existing group only through a fenced, explicit transfer: drain its
  writers, copy the selected filesystem once, verify import, then change its
  engine under the original group fence. Retain the source through verification.
  This transfer requires a dedicated migration seam; ordinary application updates
  cannot change an engine claim. That seam is not implemented yet.
- Legacy tables and readers remain while legacy groups exist. V2 does not invoke
  legacy archive, snapshot registry, warming, capture-before-stop or rotation.

Normal turns resolve the recorded engine from the retained session before legacy
setup or credential delivery. `agent-turn/native-preparation.ts` composes the
installed native provider for retained Linux groups: original preparation plan,
encrypted workspace/broker credentials, host MCP headers, finalized attachments,
and credential renewal. Missing installation or unsupported rig, resource,
generated-video preparation, lifecycle-hook or OS contracts report unavailable
preparation. Changed flags and deployment defaults cannot select legacy setup.
This bounded runner path does not enable admission or qualify a provider.

Normal native preparation also accepts full HTTPS repository references, with
an optional exact initial commit. Canonical session/current-turn inputs define
the retained plan, and live authorization precedes setup and model/tool use.
The common clone helper uses the original credential generation, skips legacy
credential seeding and preserves existing work on target conflicts. Later native
setup accepts ordinary commits descended from the pinned initial SHA; a fresh
clone still checks the exact SHA, and unrelated history stays a conflict. Its retained
setup identity recovers the original result without repeating a clone. Optional
repositories, subpath extraction and explicit Git connection preparation remain
unsupported; they require their own resource and issuer contracts.

The experimental `establishSandboxV2MachineForAttempt` helper acquires wake demand
under the exact turn fence, advances the retained lifecycle and verifies native
journal readiness on the retained incarnation. Concurrent observers share the
same transition. A timeout or lost reply retains ownership for control recovery.
The returned command transport rechecks attempt and incarnation before each
bounded provider call. Its release removes only a durably revoked attempt demand;
separate command demand remains until terminal evidence is committed.
`createSandboxV2TurnShell` binds that handle to accepted SDK calls. These seams
are not boot qualification. Full rig/resource preparation, issued background
resource/MCP lifetime and viewer/terminal/browser/desktop/port integration remain
release requirements.

API-direct access reads the retained group engine too. Viewer attachment and
Channel-A operations refuse unsupported native interactive access before
legacy environment resolution, lease acquisition or provider I/O. Desktop and
terminal stream mints return unavailable for that route rather than issuing a
legacy stream capability. Turning fresh admission off cannot change this
routing decision. Capability negotiation reports unsupported native interactive
surfaces without reading legacy placement or lease state; the ordinary command
output feed remains available. These surfaces are not advertised as warmable.
Ordinary agent PTY commands retain the live turn's existing
journal/input owner; that is separate from an independently owned human viewer,
terminal, browser, desktop or port connection.

`allocateSandboxV2BackgroundOperation` reserves the managed background row,
exact native operation and command demand in one transaction before binding or
Start. The native locator is immutable and excludes the legacy process locator.
Cancellation before launch denies binding and input, and failed registration
rolls back allocation and demand. Reservation still uses the original attempt
fence and does not remove the command from the attempt writer gate.

Job material is a separately sealed original copied under current permissions,
with no broker or renewal callback from an ended turn. Initial retention also
reserves fixed guest cleanup and its own machine demand. Delivery uses a job
directory within the real session scope, leaving the turn's activation pointer
and erasure separate. Cleanup requires physical settlement of the original job
and credential writer; its exact native acknowledgement atomically clears
ciphertext and releases only the cleanup demand. Lost or unknown outcomes hold
custody. Independent output, recovery and control ownership must still be
installed before launch. Original owner registration requires the separately
delivered credential writer's exact acknowledgement while the original turn is
live and the job remains unbound. Registration alone leaves an unbound command
in the turn's writer inventory. Once bound, its exact immutable job/custody and
incarnation identity route it to the dedicated job controller. The shared writer
predicate excludes that command only while its custody and cleanup demand remain
retained. Its physical command and cleanup demands still prevent idle retirement.
A broken demand/custody invariant holds turn cleanup and does not restore generic
control authority over the job. Unregistered jobs remain turn-owned writers.

Dedicated job control requires an installed current permission callback before
observation, cancellation and capture. It accepts no Start, stdin or renewal.
Captures atomically retain exact cursor bytes and ordinary session output events;
finished events, completion input and wake require full captured terminal output
or protected never-bound abandonment. Recovery lists original custody until fixed
guest cleanup actually clears it. A static credential deadline requests cancellation
without minting replacement material or reporting exit. Missing or withdrawn
control permission, provider errors and unknown/lost observations retain custody
and demand. The actual issuer/resource/MCP lifetime contracts remain release
requirements. These coordination checks do not qualify
guest integrity or enable admission.

`createSandboxV2BackgroundCommandTools` composes this ownership with the ordinary
native shell. The main preparer exposes `exec_command` with `background=true`,
plus `command_read`, `command_wait` and `command_cancel`, only when the retained
provider has an installed current job permission callback. Foreground execution
keeps the SDK's ordinary path. Without that callback, an explicit background
request fails before execution. Initial job launch copies the original authorized
material, completes its credential writer and registers independent ownership
before binding. The accepted source call defines a fixed job identity; a bound
recovery reads that identity and cannot launch it again. Complete SDK replies
remain in the ordinary accepted-call ledger.

Job reads require current permission before physical control and cached output.
After actual credential cleanup, historical owner metadata still identifies
retained output for a later live turn without restoring material or invoking an
ended broker. Output pages use ordinary session-event cursors and byte limits;
waiting is bounded to 50 seconds. Cancellation requests only the selected job,
and uncertainty returns held control with the retained logical state. Background
PTYs, stdin, alternate users and new credential renewal are unsupported. This
tool composition supplies no issuer endpoint or production resource permission;
the installed callback and guest integrity remain release gates.

Recovery also inventories sealed original custody whose prelaunch registration
never completed. That metadata carries no ciphertext and grants no writer
exclusion. Protected never-bound abandonment or actual complete terminal output,
plus settlement of any original credential writer, still precedes fixed cleanup.
Static expiry applies to this partial custody too, and expired original material
cannot acquire a binding or new input. A failed preparer remains recoverable
without inventing physical exit or renewing an ended turn's credentials.

Trusted platform setup uses `executeSandboxV2SetupStep` with a retained plan ID
and explicit step key. It registers no synthetic model call. A repeated step
recovers its original command and credentials; a changed command under that
identity is rejected. Secret payload input and stdin close use distinct retained
keys. Completion requires exact exit evidence; cancellation preserves the
command and demand for control recovery. Output capture retains all raw pages;
responses expose bounded UTF-8 windows and omitted-byte metadata, and each poll
budgets newly observed bytes so a large command can reach terminal completion.

`deliverSandboxV2File` binds finalized file size/hash and target path to a setup
step, reusing the ordinary atomic download verifier. Its host URL resolver must
recheck resource authority; signed URLs enter the fresh command environment,
not command text or manifest. `installSandboxV2CredentialGeneration` reuses
credential scope/path/expiry validation and delivers one immutable generation
through stdin. Its host resolver must recover that original generation after
observer loss; renewal needs a new retained generation identity. MCP headers
remain host-side. The worker credential lifecycle supplies retained renewal and
ordered activation; its execution owner joins local SDK/MCP callbacks and renewal
before reconciling the original native writers. Provider qualification is separate.
The experimental worker `prepareSandboxV2TurnShell` composes those helpers with
explicit hook steps from a frozen host plan, then binds the SDK shell to the
exact attempt. Credential files are sourced off-manifest at command creation.
`sandbox_v2_preparation_plans` retains the complete nonsecret definition under
the exact active attempt/incarnation fence before any preparation side effect.
The table is immutable, append-only and session-restricted under FORCE RLS.
`loadOrCreateSandboxV2TurnPreparationPlan` recovers that original definition
before building current setup inputs. Conflicting plans, changed attempts or
incarnations fail closed; this seam supplies no cross-attempt adoption.
`createSandboxV2CredentialGenerationOwner` supplies host recovery for one exact
generation. It normalizes broker material, then retains an AES-GCM encrypted
original outside the preparation plan before native input delivery. The operator
key stays outside Postgres. Authenticated plaintext binds the original attempt,
machine incarnation and nonsecret request definition. Concurrent candidates use
the winning original; recovery never refreshes its bytes. Scope mismatch,
expired/cleared originals and incompatible keys reject without secret-bearing
validation errors.

Current credential grants and the live attempt fence precede decryption,
preparation and every cached model/tool dispatch. Dispatch reads small metadata,
without loading ciphertext. The host must supply an independent credential-grant
checker; an attempt fence does not grant resource access. The generation table
is FORCE-RLS and session-restricted. Its only update erases ciphertext after the
exact attempt is closed and physically quiesced with all writers settled,
leaving an immutable identity tombstone and successor generations intact.
`createSandboxV2CredentialLifecycleOwner` retains cleanup ownership before broker
resolution, activates only complete original writers, and preserves a pending
renewal's predecessor across observer loss. Ordinary dispatch joins this owner's
already-started refresh, then rechecks current authority and expiry. A foreign
pending ticket or failed/unknown refresh stays unavailable. Dispatch does not
mint a replacement. The worker seals independently
selected workspace inputs separately, including an empty input, so later renewal
observers keep the original base values. Broker values take precedence. Ordered
host MCP switching follows activated generations; headers never reach guest files.
The fixed guest cleanup removes only the revoked original attempt's versions and
preserves a successor pointer. Its retained intent/proof participates in the full
writer predicate. Native quiescence and original ciphertext erasure commit
atomically after cleanup and all other writers settle.

`apps/worker/src/sandbox-v2-resources.ts` resolves canonical current-turn file
refs under the exact live attempt/incarnation fence, then uses the ordinary file
owner/provider ACL. Historical session attachments remain receipts. Finalized
size, SHA-256 and target paths are frozen in the preparation plan; changed,
deleted or unauthorized files fail closed. Storage and its network audience are
explicit. Only a fresh download Start may mint a short-lived URL; completed or
ambiguous native recovery never refreshes download material.

Prepared file metadata creates SDK directory descriptions without contents,
object keys, signed URLs or manifest mounts. The supplied session and declared
manifest match, so provided-session preparation performs no delivery. Preparation
and every model/tool dispatch recheck current file authority, including cached
completion replay. The host resource callback composes with model admission.
Other resource kinds, generated dependencies and full SDK manifest operations
still require native owners.

The runtime `BuildAgentOptions.machineSandbox` accepts the exact prepared session
and native capabilities. `runAgentStream` supplies that session directly to the
SDK, sharing the ordinary model admission, approval, lazy-tool, history, modality,
compaction and measurement pipeline with the provided legacy path. It installs
no create/resume/delete or legacy credential/setup/cancellation fallback.
Unsupported legacy preparation and resource declarations fail before execution.
The main worker uses this binding for its bounded native preparation contract.
Rig versions requiring no preparation may supply their frozen configuration;
their prompt names the pinned version and retained sandbox group. A newer active
version cannot introduce setup into an existing session. Rig scripts, image
contracts, checks and credential hooks still reject before establishment or
credential minting until native owners support them.
Before the first write it installs the same finalization owner; agent dispatch
remains closed until preparation completes. Ordinary completion and interruption
both require native drainage and a durable original receipt. Finalization observes
the same retained operations within a bounded budget; timeout, unknown and lost
ownership keep the receipt closed. Remaining manifest/resource, platform-hook,
product ownership and provider qualification are release requirements.

Workspace Skill checkout/publication and code search use the ordinary attempt
gateway plus the same native execution owner. An accepted SDK correlation is
namespaced by exact attempt and tool to recover its gateway operation; it grants
no permission, and gateway authorization still runs on every invocation. Native
filesystem steps use logical paths and immutable request file/directory ordinals.
Search steps use validated query identities and original output-token offsets.
The retained executor records original results before advancing journal cursors;
reconstructed observers recover those results rather than repeating physical
work. Native directory framing is stable within that operation. Large standalone
writes use stdin, and compressed search frames fit the bounded native response
window. Structured host file reads may select a window up to 4 MiB; ordinary
model commands retain their 256 KiB default. Current file grants are checked
before cached workspace results as well as physical writes. Legacy sessions
keep their existing command and framing path. Connector attachment placement,
background resource/MCP lifetime and interactive product owners remain required.

The gateway supplies a host digest of its authorized request and preserves the
prepared arguments and caller. Native workspace operations retain that digest,
their operation ID and, for Skill checkout, the original source digest before
their first filesystem step. These metadata-only definitions share the protected
preparation store and contain no source bytes or execution proof. A changed
request or Skill snapshot cannot add new child paths to the original operation;
it remains held. Current authorization is still required on recovery. This is
not an atomic snapshot of a live workspace directory.

## Machine lifecycle

Persist one transition before dispatch. Conflicting provider mutations cannot
overlap, including after coordinator death. New demand may cancel a reserved,
undispatched idle suspend; after dispatch it waits for that transition to settle
and only then resumes. A lease expiry, current provider state or failed HTTP call
cannot alone prove an old request will never arrive later.

Uncertain outcomes remain reconciling. Adapters must distinguish terminal proof
for an exact transition from an observation of current state. Native idempotency
can permit retry of the same operation, never a fresh operation replacing an
ambiguous one. Deterministic names are discovery keys, not absence proof.

The Docker adapter creates a stopped container plus a labeled named workspace
volume from a pinned image digest. The next transition starts it. Pause/unpause
preserve memory; a changed boot is an unresolved outcome, never an automatic
replacement. Dispatch uses an immutable container ID after creation. Recovery
checks the original labels, volume and image. A lost mutation reply can settle
only after the daemon's locked inspection observes a change from the recorded
pre-transition state. This relies on one exclusive lifecycle owner and a daemon
whose mutation/inspection locking has been qualified. External container changes
and a request that never reached the daemon remain unresolved. Destruction is
two durable stages: remove the exact container, retain the `destroying`
state, then remove its owned workspace volume. Each transition issues one
mutation. Lost replies or coordinator death between those steps do not strand
the volume or license another container mutation. Final destruction settles only
after both resources are absent.

Seal the nonsecret creation body with its reserved transition before dispatch.
Recovery uses that retained image/resource/network definition, never the current
deployment defaults. SQL preserves the same transition body and forbids resetting
a dispatched or unknown phase. Retained instance and disk identity must agree
before any provider request. Optionless local-volume cleanup may receive Docker's
exact reference-in-use refusal: the name-locked guard rejects before driver
removal, so that request may settle without an effect and a new durable transition
may try later. An arbitrary error, timeout or lost refusal cannot supply that proof.

Active attempts, unresolved starts, adopted commands, byte-reading operations,
and live terminal/viewer/browser/desktop owners prevent idle suspend. Durable
commands do not expire because their observer's heartbeat expires. Product Pause
and Cancel revoke exact attempt/command authority and stop writers; freezing a
machine does not establish quiescence. Sibling sessions remain independent.

## Command journal

An operation ID binds an immutable command specification and exact machine/disk
lineage. Persist the claim before launch; retries observe the original command.
Return output by byte cursor, retain terminal receipts/tombstones, and reject
specification conflicts. Detached supervision owns descendants, stdin sequences,
cancellation and final output. Publish terminal state only after physical
quiescence and output durability are proved.

The unified session persists a numeric handle before Start and captures decoded
output and byte cursors atomically. Recovery reads the retained operation without
refreshing its launch environment. Each accepted stdin action binds its full digest
and ordered chunk positions, including identical chunks. Validate the action and
command mode before allocating a sequence. Capture and cancellation-proof commits
recheck exact owner authority in their own transaction. Output polling stops after
its budget or accumulation target; one already-read page may exceed that target.
The command adapter and protected turn-owned command store are implemented.
Accepted input actions reserve whole contiguous sequence ranges. Output capture
recomputes decoded text and UTF-8 suffixes from the exact byte page before its
cursor CAS. SQL guards reject malformed terminal evidence, and session deletion
waits for unresolved commands and machine cleanup even after a turn has ended.
An unbound allocation can be abandoned permanently; a bound dispatch cannot.
Separate control reconciliation can observe/cancel revoked work and settle real
terminal receipts without advancing agent output or restoring execution rights.
Cold-machine wake acquires the exact live attempt under the canonical turn fence
before lifecycle I/O. Recovery inventories attempts independently of commands,
including owners that died before allocating a command. Releasing a revoked
attempt removes only its demand; siblings and unresolved physical commands stay
held. The finite control pass rechecks each retained owner before inspection,
cancellation and terminal settlement. Diagnostics cannot interrupt other owners.
The control worker starts a bounded global inventory sweep from the existing
lifecycle tick. Inventory reveals only machine routing identities through a
PUBLIC-revoked, target-schema definer; direct table reads stay tenant scoped.
Its protocol queue is separate from legacy lifecycle workers, so older binaries
cannot consume unregistered v2 workflow/activity types during a rolling update.
Each machine has its own child workflow. Independent attempt/command/job cursors
prevent a shorter inventory from resetting while another still has pages;
later sweeps restart all three. The job cursor uses a workflow patch marker.
Missing adapters or a missing installed job-control callback defer retained work. Control recovery
continues across admission-flag changes and grants no fresh agent authority.
Captured output remains keyed to its accepted action after observer death; the
loader reconstructs every preceding byte page and rejects cached text or terminal
evidence inconsistent with committed cursors. Deferred SQL validation restores
the exact parent account, workspace and subject scope even when the enclosing transaction has restored
an outer scope before commit. The
accepted-tool seam registers the call before execution and stores its complete
formatted reply in the existing tool ledger before returning it. Replays recover
that reply. A newer exact attempt in the same logical turn may read a retained,
completed predecessor reply only after that origin is closed, quiesced and free of unresolved
writers, with the same frozen session authority. The originating receipt stays
immutable. This read grants neither unfinished-action adoption nor execution or
stdin authority over the original command. Compound tools use explicitly named operation sessions; each physical
action hashes the original call ID and stable step key into its causal identity.
Root actions use the same encoding. Stdin, close and resize steps each need their
own key. No counter or newly generated key may identify a retried step.
The bounded, tenant-scoped control inventory retains original dispatch identities
and grants no new execution, cancellation or output rights. Each subsequent
control operation rechecks its exact durable owner. A scan resets after its last
page so concurrent random-ID insertions cannot remain permanently behind a cursor.
The Docker command transport is pinned to an immutable container ID and never
starts or replaces a machine. Its daemon endpoint is the lifecycle adapter's exact
Unix socket. Managed-provider lifecycle integration, issued job resource/MCP
lifetime, complete resource preparation and interactive product owners remain required
before admission.

The SDK command and text-edit binding registers the exact original function call
before execution and retains its formatted reply before returning to the SDK.
Each concurrent invocation has its own journal session and cancellation signal.
Both exec and stdin errors propagate uncertainty instead of storing retry advice
as a successful result. Native pipe commands retain stdin/polling support even
when the machine has no PTY capability. This binding does not establish a
machine, prepare files or grant replacement-attempt authority; turn routing must
compose those boundaries before installing it.

`packages/runtime/src/sandbox/v2/filesystem.ts` implements bounded UTF-8 text
editing and read-only images over those same retained native commands. The SDK retains its diff
parser, editor binding and runAs selection; the function tool accepts one
structured operation per call. Read, publication, payload and stdin-close use
explicit fixed child identities. Transport/outcome uncertainty escapes the
SDK's text-error renderer before any formatted reply is retained. Completed
replay reads the stored reply without filesystem work or credential resolution.
Fresh edits also bypass broker environment resolution; file payloads use stdin
and the image's Bun executes with an empty environment.

The Linux/Bun helper walks workspace-relative directory descriptors, refuses
symlinks and nonregular files, and bounds files to 128 KiB. New files and move
destinations must be absent. Updates check the originally retained source text
and preserve ordinary file permissions before publication. These checks do not
claim atomic CAS against unrelated writers; moves publish a destination then
remove their source. Unsupported runtimes, larger files, general binary transfers
and full SDK manifest resources require separate owners.
This editor supplies no journal-integrity, guest-isolation or machine-lifetime
qualification.

Native `view_image` uses a distinct fixed read/input/close sequence, validates
PNG/JPEG/WebP bytes with the ordinary image validator, and caps each file at
2 MiB. Its 4 MiB capture window holds the complete base64 response. The original
SDK data URL is retained before conversion to structured model pixels; recovery
uses that result without reading a changed file or resolving broker credentials.
Image helpers use an empty environment. Current resource permission precedes
dispatch, cached replies and pixel return after a fresh read. Known file/format/
size failures retain explicit text; uncertain outcomes still escape the SDK's
error renderer without acknowledgement. Models without image input omit the tool.
The ordinary image-history callback participates in the native invocation drain
and uses the existing fenced artifact/object-storage owner. This supports bounded
workspace image viewing; human interactive viewers remain a separate contract.

`apps/worker/src/activities/agent-turn/native-generated-image.ts` delivers an
already retained generated image from this same session and turn. The existing
media flow selects this native owner before the deployment's legacy backend
setting. Ordinary causal-human file access and the canonical ready artifact
must still match the receipt; receipt identity grants no access. The complete
nonsecret file metadata is retained in `generated-image:v1:<artifactId>` before
the named file setup step runs. A fresh URL uses the installed explicit storage
audience and stays outside the plan and command text. The file owner rechecks
current permissions before dispatch and after delivery; completed replay also
checks permission but does not mint a URL, rerun the download, resolve broker
credentials or overwrite later workspace edits. The actual callback remains
inside the turn invocation drain, and physical uncertainty stays with the
original command and finalization gate. Failed delivery remains deferred while
the existing artifact receipt stays retained. This supports current-turn image
placement only; historical generated inputs, full dependency/manifest resources
and cross-attempt setup adoption remain separate contracts.

The journal gives at-most-once launch while its authoritative disk history
survives. It cannot give arbitrary external effects exactly-once. A crash between
claim, launch and receipt may leave an unknown outcome. Restoring an older disk
can erase a claim: retain dispatch/lineage authority outside that disk and refuse
relaunch when provenance cannot establish the claim is current. Missing receipts
and a changed process identity never authorize a new launch.

The guest journal is failure-recovery evidence, not a security boundary against
guest root. Keep provider/account credentials and control-plane authorization
outside the guest. Short-lived run authority stays exact-attempt scoped; disk and
RAM restoration must not revive revoked credentials.

## Resource and provider qualification

Compare the same useful workload, not an equal nominal VM size. Most work can
remain small while bursts need substantially more CPU or RAM. Record minimum
billable floors, actual-versus-reserved billing, burst limits/pressure, and changes
requiring restart. A tiny initial reservation with automatic growth is the primary
requirement: lightweight active work must not reserve every machine's possible
peak. Shrink and memory reclamation after a peak are useful secondary properties.
An explicit resize endpoint or selecting a larger size at creation does not
establish automatic growth. Verify each resource and provider class separately.
Suspend and scale-to-zero are separate properties from resource elasticity.

Trace CPU time, resident/charged RAM, retained/cache memory, disk and network
across file edits/searches, dependency work, builds/tests, background services,
browser/desktop and concurrent group members. Compare integrated billable usage,
completed-task time, failures, suspension overhead and retained storage. Verify
host-loss/retention guarantees, region, images, background progress and provider
hard spending controls. Document measured, documented and unknown facts separately.

Self-hosting is a separate provider qualification, not a conclusion from the
single-daemon Docker adapter. Evaluate an existing isolated runtime and fleet
controller before building one. Small scheduling requests and larger resource
limits allow a container's actual footprint to grow without resizing, but that
growth still consumes the current host's finite capacity. Node autoscaling does
not by itself supply headroom to an already running workspace.

Qualify whole-host overhead, placement, simultaneous bursts, noisy-neighbor
containment and capacity arrival time together. Test node loss and partitions
before transferring persistent storage: a deleted Pod or expired heartbeat cannot
prove the original writer stopped. Preserve setup, home and journal history across
relocation; a workspace-only mount is insufficient for arbitrary installed tools.
Measure completed work and total fleet cost, including idle hosts, durable
storage, networking and operations. A dense single-host trace establishes neither
secure isolation nor a scalable, durable fleet. Managed and self-hosted candidates
remain open until these gates pass.
Runtime qualification also covers syscall and filesystem compatibility, workload
escape attempts, per-tenant ingress/egress, metadata and control-plane reachability,
and storage attachment authority. A network policy label or a runtime name is not
evidence that these boundaries are enforced.

## Validation gates

Adversarial checks cover claim/launch/receipt crash windows, lost replies,
concurrent identical requests, conflicting specifications, output replay, stdin
retries, detached descendants, cancellation, disk rollback, late lifecycle calls,
coordinator death, demand during suspend, and mixed legacy/v2 groups. Real Docker
and each selected managed or isolated self-hosted runtime must exercise the same
integrated journal, session and lifecycle conformance path.
Private account information and live diagnostic evidence remain outside this
repository. No rollout or main merge is implied by this worktree.

`test:integration` includes a real Temporal check that legacy workers continue on
their queue while v2 recovers independent machines and unequal inventories across
workflow continuation. `JOURNAL_CONFORMANCE_IMAGE` enables the finite Linux plus
PostgreSQL SDK regression for dropped stdin replies, retained replies and Pause.
