# Keeper-owned native command transport

Status: implementation in progress; not an admitted runtime capability. The
current increments provide bounded framing, a native bootstrap preflight,
input/output custody state machines, encrypted atomic transport storage, a
private inherited supervisor channel, strict command-definition codec, native
initial-process command multiplexer, journal-backed host transport driver and
canonical retained-command descriptor/output fences.
The native `broker` mode and host driver can launch fixture commands, but no
application command-admission route selects this protocol.
These increments do not change a production protocol tuple or qualify an
existing sandbox. The existing [command supervision](../command-supervision.md)
and [native keeper](../../agent/native/command-supervisor/README.md) contracts
remain authoritative until the complete new path is independently qualified.

## Selected ownership boundary

The trusted initial sandbox executable retains the immutable sealed supervisor
artifact. A versioned broker owned by that keeper will start each command's
supervisor from its own sealed descriptor, capture its pipe or genuine PTY
streams, and independently observe that exact supervisor's exit. Requests and
responses use the provider-authenticated **initial sandbox** input/log channels,
not an ordinary mutable-path command invocation.

This deliberately does not claim a provider execution ID is an OS PID. It does
not grant new capabilities or promise hostile same-UID/ptrace isolation. The
initial executable, actual sealed bytes, physical sandbox identity and retained
keeper identity still need authenticated admission before user setup. Existing
warm groups, snapshots and legacy descriptors are not retrospectively enrolled.

## Bootstrap preflight

The static supervisor's `broker-preflight --broker-id UUID` mode tests the
proposed execution primitive without accepting a user command. The initial
executable seals its own bytes, then forks fixed capability/byte-inspection
children from that descriptor using `execveat(AT_EMPTY_PATH)`. It does not ask
the provider to execute `/proc/PID/fd/FD`, run a mutable guest launcher, grant
capabilities, or fall back after syscall/policy denial. Pipe and newly allocated
controlling-PTY checks execute the existing capability modes. The old keeper
and inherited-PTY launch/control contracts are unchanged.

The parent pins each child with a pidfd before allowing exec, independently
reaps it, and accepts only the exact expected sealed-object identity, bytes,
and capability output. Each child observation has a five-second bound; failed
observations have a two-second pidfd-based cleanup bound and never emit success.
Only after all checks pass does the initial process emit bounded `OGB1` hello,
artifact chunks, and an exit frame. The complete bytes must still be checked
against independently retained build provenance by the host. The hello protocol
is `native-command-broker-preflight-v1`, its state is `preflight_only`, and the
final payload explicitly reports `commandAdmission: false`.

This probe does not implement input dispatch, authenticated command admission,
request/outcome persistence, output custody, native cancellation, or restore
compatibility. A local pass also does not qualify initial-process delivery on a
remote provider. It is a prerequisite experiment for the broker, not a fallback
for the existing provider-path contract.

The strict host collector in `native-command-broker-preflight.ts` requires the
complete initial-process transcript, contiguous frame and artifact offsets,
independently pinned size/target/SHA-256, no stderr, and an independently observed
zero initial-process exit. It rejects partial output, reordered or duplicate
frames, extra output, mismatched bytes and unknown exit. Its result always has
`commandAdmission: false` and is not a durable broker binding.

The initial implementation was exercised on a normal Linux 5.15 kernel and a
disposable Modal V1 sandbox on October 12, 2026. The latter started the fixed
preflight as the initial process of a new provider-built image containing the
exact static ELF. All returned sealed bytes matched the independently retained
artifact and both pipe and newly allocated real-PTY capability children exited
successfully. No provider TaskExec, running-guest file delivery, mutable-path
bootstrap or granted capability was involved. The successful observation covers
only this fresh-image bootstrap primitive; it does not qualify arbitrary command
admission, cancellation, durable input/output replay, or old-snapshot handling.

## Bounded framing

The native `launch-channel` primitive supplies the broker's per-command control
link: an unnamed, inherited Unix sequenced-packet pair with distinct pipe/PTY
protocol names. It reuses the supervisor's idle/release, pidfd cancellation,
ECHILD receipt and exact ACK behavior without a mutable guest socket pathname.
Channel loss or response backpressure permanently closes launch and drains owned
descendants before exit 125; that exit supplies no receipt or clean ACK proof.
Creation-time parent credentials only check the intended topology. They do not
authenticate a host invocation or make a transferred socket trustworthy. The
broker's sealed initial custody and full dispatch/exit binding remain required.
The native broker calls this primitive; an admitted runtime route does not yet.

The internal codec is
`packages/runtime/src/sandbox/providers/native-command-broker-wire.ts`.
Each frame is one ASCII line with twelve tab-separated fields:

```text
OGB1 direction brokerId ownerEpoch sequence requestId commandId kind offset size base64 payload
```

The displayed spaces above stand for literal tabs. The frame terminator is one
LF; CR and arbitrary whitespace are not normalization rules. UUIDs are lowercase
canonical versioned UUIDs. `commandId` uses `-` only for broker-level frames.
Epoch and sequence are positive safe integers; offset and size are nonnegative
safe integers. Decimal spellings are canonical, with no signs or leading zeros.
Payload is canonical padded base64 of exactly `size` bytes. Base64 protects byte
framing, not confidentiality, authenticity or losslessness.

Payload chunks are at most 8 KiB; a complete frame is at most 12 KiB; one decoder
input is at most 64 KiB. Larger command definitions, artifact bytes and output
need explicit offset-addressed chunking. These are transport bounds, not limits
on command lifetime or total output. A malformed frame, unsafe integer,
conflicting physical broker identity or oversized suffix poisons the decoder.
It cannot skip forward to a plausible marker or interpret a gap as EOF.

The codec has separate closed request and response kind sets. It validates
framing only: it neither authorizes the operation nor interprets an output
payload as a quiescence receipt. Request bodies still need operation-specific
native validation. The decoder exposes replayed frames unchanged so the durable
inbox, rather than an in-memory parser, decides whether they are exact duplicates.

The native `broker_request_decode` implements the same closed one-frame request
contract and canonical base64/decimal rules. It accepts no response kind, returns
no pointer into caller input and clears partial results on rejection. It is a
parser, not the input-stream state machine: its caller must refuse gaps,
poison malformed streams and enforce writer/request replay and the provider's
uint32 input-index bound before any side effect. The native broker supplies that
caller. `make test-broker-codec-parity` compares native framing and definition
parsers against the real host codecs, including byte-mutated and truncated input.

## Literal command definitions

The internal host codec `native-command-broker-definition.ts` and native
`broker_definition_decode` agree on a bounded binary definition. Neither
accepting nor decoding a definition starts a command. This body will be carried
by the offset-addressed `definition` chunks, separately from the later launch
and release operations. There is no JSON coercion, shell interpolation, implicit
environment inheritance, `runAs` fallback or version guessing.

The 20-byte header is `OGCD1` followed by NUL, a mode byte (0 pipe or 1 PTY), a
reserved zero byte, big-endian uint16 rows and columns, then big-endian uint32
argument and environment-entry counts. Every subsequent string is prefixed by
its big-endian uint32 byte length: absolute cwd, ordered arguments, then ordered
environment key/value pairs. Strings must be canonical UTF-8 without NULs;
invalid encodings, overlong sequences, Unicode surrogates, duplicate environment
keys, unknown flags and trailing bytes are rejected. Environment keys use ASCII
`[A-Za-z_][A-Za-z0-9_]*`; values and noninitial arguments may be empty.

The body is at most 256 KiB, with 1–1024 arguments and 0–1024 environment pairs.
Every string and complete `KEY=value` entry is at most 131071 bytes. Pipe mode
requires zero dimensions; PTY mode requires dimensions from 1 to 65535. These
are definition/transport bounds, not command lifetime or total-output limits.
Oversized or unsupported requests must be refused explicitly before launch,
not truncated, normalized or silently switched to another execution mode.

The native decoder frees partially allocated state on every rejection. A
test-only native harness reconstructs the actual parsed body without executing
it. `make test-definition-parity` compares that harness against the real host
codec over positive, truncated, byte-mutated and boundary fixtures. The harness
is not a production subcommand, and this codec does not establish provider
admission, custody or native cancellation.

## Native initial-process multiplexer

`broker --broker-id UUID` is the separate `native-command-broker-v1` executable
mode. It seals its own static ELF and exercises pipe/controlling-PTY capability
children through `execveat(AT_EMPTY_PATH)` before emitting hello and actual sealed
artifact bytes. Required `close_range(CLOSE_RANGE_CLOEXEC)` support is checked
before hello. The host must independently verify those bytes and the exact
initial provider process; neither a printed hash nor starting this CLI locally
establishes authenticated admission. The old keeper mode is unchanged.

The initial process owns one nonblocking input stream, one encoded output stream
and each command's separate supervisor, private control pair and pipe or newly
allocated real PTY. It pins a supervisor pidfd before releasing its pre-exec
barrier, then executes only the retained sealed descriptor. Child `close_range`
marks every extra descriptor close-on-exec; only that command's control endpoint
survives into its supervisor, and it is closed before user code. No mutable
pathname launcher, extra capability, provider TaskExec, inherited environment or
shell interpolation supplies the supervisor. Command cwd, argv and environment
are the validated literal definition. New supervisors remain idle until release.

After the initial empty fence, command requests have these explicit bodies:

| Request | Body and effect |
| --- | --- |
| `prepare` | Four-byte big-endian total definition length; reserves a fresh command ID, not a process. |
| `definition` | Consecutive offset-addressed definition bytes, at most 8192 per frame. |
| `launch` | Empty body, offset zero; validates the complete definition and starts exactly one idle sealed supervisor. |
| `control` | Literal `status`, `release`, `cancel`, or `ack` + TAB + exact receipt UUID. One pending private control request per command. |
| `stdin` | Nonempty bytes at the exact input offset; bounded nonblocking write. A separate result reports completion or partial-write failure. |
| `eof` | Empty body at the exact input offset, after pending input settles; closes only pipe stdin. PTY half-close is explicitly unsupported, not simulated as Ctrl-D or output loss. |
| `resize` | Four bytes: big-endian uint16 rows and columns, both nonzero, on a real PTY only. |

Broker-only `ack` acknowledges the sent output prefix named by offset; `replay`
starts at the first unacknowledged frame, without new output sequence numbers.
These are not native receipt ACKs. Input acceptance only confirms its reserved
identity; a separate result records the operation. Exact immediately previous
input replay retransmits retained output without executing the operation again.
Stale epochs, gaps, conflicting input reuse and malformed framing poison the
initial channel and fence further launches. Higher writer fences do not cancel,
restart or rebind already launched commands.

The output queue retains at most 4 MiB including frame storage, reserving 128 KiB
for control metadata. Data reads pause before that reserve; cancellation, control
replies and independent supervisor observation continue. Sent output is retained
until host acknowledgement. Partial writes never interleave protocol lines. An
ACK racing a partially written replay lets that line finish before collection.
Exhausting even the control-response window triggers exceptional shutdown rather
than dropping evidence or deadlocking a pending acceptance. The host must commit
capture and send bounded/coalesced ACKs; it must not ACK every ACK into an idle
loop. This memory queue is not the host's durable journal.

The broker caps command definitions, pending input and identity tombstones at
16 MiB. Completed bodies are freed, but command IDs are never recycled. Capacity
failure rejects new preparation/input explicitly; it does not impose a command
run-time limit or terminate a normally running command. Readiness-driven polling
has no periodic idle wakeup; sent-but-unacknowledged data does not busy-poll a
writable stdout descriptor. Command output is always encoded, so protocol-looking
user text cannot masquerade as initial-process control output.

Native quiescence receipts are forwarded from the private supervisor channel.
Only after exact receipt ACK does a normally exiting supervisor return zero;
the broker independently reaps it and waits for captured stream EOFs before its
separate `supervisorExitCode` frame. Neither that frame nor input acceptance is a
replacement for the receipt. Pre-spawn cancel closes a birth as `not_started`,
without fabricating a supervisor receipt. Initial-channel EOF/error, TERM/INT/HUP,
unexpected supervisor death or malformed input closes all owned private channels
and keeps the broker subreaper alive until kernel ECHILD. It returns 125, never
claims clean settlement. Initial-channel closure wins over buffered release.

Local native tests exercise the actual static executable, including literal
environment/argv, binary stdin, multiple commands, detached/clone writers,
duplicate release, writer takeover, real PTY, descriptor hygiene, full data-window
cancellation and fatal-channel cleanup. They do not replace exact remote-provider
qualification, the host admission/retention integration, the 100-repetition and
35-second cancellation gates, or preservation-safe old-group compatibility.

## Durable transport obligations

The pure input transitions in `native-command-broker-input.ts` serialize a
single pending input and require a committed dispatch intent before yielding
provider write bytes. A provider RPC acknowledgement does not clear that input.
Only the exact broker acceptance does. A replacement writer retains the old
pending epoch, index and body verbatim, resolves it, then appends its own fence
before any new command request. Modal 0.9.0 serializes the provider index as
`uint32`; the transitions refuse exhaustion rather than wrapping. Command EOF
is an encoded request and never closes the initial broker stdin.

The native `broker_input_accept` reducer mirrors the ordered side of that
contract. It requires a broker-only empty first fence, consecutive uint32 input
indexes, strictly increasing fence epochs and the currently accepted epoch for
ordinary requests. Only the exact immediately previous body may replay; older
indexes and conflicting reuse reject without changing state. Exhaustion refuses
new input instead of wrapping. The reducer reserves a new body's identity before
the native broker performs its operation; replay never authorizes that operation
again. A malformed frame has a distinct invalid result which the stream owner
treats as poisoned input, never resynchronizes past. This bounded native state
is not the durable global request-ID index, host command-birth ledger or an
admission decision.

The output planner in `native-command-broker-output.ts` keeps all command
frames and the incomplete framing suffix in one atomic capture plan for the
initial stdout cursor. It requires exact durable hashes for frame replay,
rejects conflicting pages and sequence gaps, and keeps provider EOF separate
from command settlement. Real Modal V1 cursor-less EOF batches preserve the
last data cursor and gain a separate observation. The independently read initial
stderr stream cannot advance that cursor or claim its EOF.

The database adapter in `packages/db/src/native-command-broker-transport.ts`
and runtime coordinator in `native-command-broker-transport.ts` implement the
transactional transport journal. The core composition keeps the runtime package
independent of the database package. Registration requires the exact attributed
warming lease, creation operation, provider namespace and physical instance;
the initial state hash and binding cannot be changed by registration replay.
Neither registration nor a supplied bootstrap-evidence hash certifies the
bootstrap or grants command authority.

Each database operation locks the lease before the scoped broker row. Input
reservations, immutable unique request receipts and state changes commit
together; frame/page receipts, partial suffix, shared cursor and matching input
acceptance also commit together. Rows use FORCE RLS, entries are append-only,
and the deployment's existing environment-encryption key encrypts state and
receipt contents with a scope-bound envelope. Indexed hashes remain content
integrity checks, not authentication. The journal refuses transaction/savepoint
handles: a dispatch result must follow an actual outer commit.

A thirty-second database writer lease elects the transport writer, not command
lifetime. Expiry preserves pending writes and requires a higher writer epoch;
it never settles a process. Old physical-instance output remains collectible
after replacement, but new input is refused. Initial-process EOF also fences
input without converting it into a command exit. The current PostgreSQL
integration tests exercise races, rollback, restart replay, exact scopes and
partial-frame capture with the non-owner app role. The host driver invokes this
journal in explicit fixtures, not application sessions. Canonical command
admission routing, creation/bootstrap binding, journal retention/purge lifecycle
and fully qualified physical control remain required before activation; an
unresolved journal must not be deleted to unblock a lease
or workspace teardown.

### Host transport and command evidence

`native-command-broker-driver.ts` composes committed journal transitions with an
exact initial-process channel. A fresh input dispatch follows the actual intent
commit. Re-entering an already-dispatched request returns a reconciliation state,
not another physical write. Explicit `replayPending` preserves the original
bytes, index and epoch; an expired writer first resolves that pending input, then
sends its newer fence. A provider response or a timeout cannot clear the pending
request. Local overlapping input calls refuse rather than queue stale release
work; output collection runs independently of input dispatch.

`modal-native-broker-channel.ts` owns a dedicated Modal 0.9.0 client using the
verified non-retrying control-plane middleware. It addresses only the original
sandbox stdin and stdout, checks the exact task before a write, preserves abort
signals, and never sends initial EOF as a command operation. Closing this host
client does not terminate the sandbox or close its initial stdin. Observation
containment deadlines do not limit command lifetime. Initial stderr and creation
provenance remain separate admission obligations, not guessed from empty stdout.

Output pages commit before the driver asks for a successor. Restartable bounded
frame reads verify immutable ciphertext/hash/scope and the numeric sequence
order. `native-command-broker-bootstrap.ts` reconstructs only the initial hello
and complete artifact prefix, checks actual bytes against the independently
selected pin, and returns no command authority. A later hello, partial artifact,
provider EOF or self-reported hash is not an authenticated initial admission.

`native-command-broker-command.ts` projects each command from committed frames.
It joins control evidence to the exact accepted immutable request and ties data,
stream EOF and independent supervisor exit to the original launch epoch/request.
The snapshot keeps UTF-8 suffixes and offsets separately for each stream. Native
receipt, its exact ACK response, both stream EOFs and independently observed zero
supervisor exit are distinct requirements. User output is always text; neither
protocol-looking output nor initial-process EOF can settle a command. The caller
must atomically capture this projection and persist the receipt in canonical
retained-process custody before ACK and holder/admission settlement.

`ModalBrokerProviderCommand` is a distinct contract, not a task-router locator.
Its command UUID, launch request/epoch and original broker binding are immutable;
frame capture, per-stream bytes/EOFs and the observed receipt ACK advance
separately. `retainedNativeBrokerCommandSnapshot` reconstructs the projection from
that locator and the independently persisted native receipt. The existing
TaskExec/session adapter explicitly rejects this descriptor, rather than treating
its UUID as a provider execution ID.

The maintenance-only candidate migration `0739` extends the canonical retained
process guard without changing legacy descriptor/path rules. A broker command
must match its registered account/workspace/group/lease/physical task and provider
namespace. One native birth cannot own two retained process rows. Its shared
frame cursor cannot pass committed transport frames, regress or advance outside
atomic output capture. `captureRetainedBrokerOutput` commits session output and
the projection cursor together; a losing reader discards its page. An ACK cannot
precede a durable native receipt, and both output EOFs plus an independently
observed zero supervisor exit are still required before the ordinary retained
process, holder and parent admission can settle. Initial-process EOF is not an
input to that settlement. The existing bounded session-output recording policy
remains unchanged; the encrypted transport journal is separate custody.

These retention guards are not bootstrap authentication, cohort qualification or
permission to launch. No application route selects broker execution yet. New
creation/restore selection, release authority, the runtime command-session
adapter and journal retirement remain separate integration requirements.

The opt-in local static-ELF/real-PostgreSQL test in
`packages/core/test/native-command-broker-transport.integration.test.ts` runs
with `OPENGENI_NATIVE_BROKER_LOCAL=1` after building the static artifact with
`make -C agent/native/command-supervisor test-static`. It checks unknown
dispatch, exact replay, writer takeover, duplicate-release refusal, binary I/O,
canonical receipt-before-ACK, atomic retained output and independent exit using
the actual broker. Its admission/holder rows are explicitly test-seeded, not
evidence of product-reachable command admission. Ordinary CI does not require
that local native build; the deterministic provider boundary
and real database transport cases remain separate. This fixture does not
establish Modal admission, image provenance, old-warm compatibility or release
qualification. No runtime application session currently constructs the driver.

Before any physical write, the control plane must persist the exact broker,
physical instance, writer epoch, request ID, provider input index, body and
outcome state. A single durable per-instance writer owns indexed input. New
writers must fence stale release/input before sending them. Index exhaustion
must fail closed; no wrapping, reset on reconnect or fresh request on ambiguous
dispatch is permitted.

Provider acknowledgement, broker acceptance, native receipt and host durable
acknowledgement are four distinct facts. Indexed provider replay behavior must
be tested before retransmission is allowed. A local timeout cannot manufacture
pre-dispatch rejection. Broker deduplication must reject conflicting reuse and
never start a command twice, even if the provider repeats input.

Every output frame has a stream byte offset and immutable sequence. The broker
must retain unacknowledged output and response evidence. The host must commit
every included frame and the incomplete framing suffix before advancing the
shared provider-log cursor. Provider entry boundaries are not frame boundaries.
Ordinary child output is captured separately and encoded; it never writes raw
protocol frames onto the initial channel. Bounded backpressure must not prevent
cancellation or receipt observation. Neither log EOF nor broker EOF is command
EOF or proof of descendant death.

## Native settlement and activation

The per-command supervisor remains idle until durable release authority exists.
Cancellation, kernel `ECHILD`, immutable receipt replay, receipt-before-ACK and
the supervisor's independent post-ACK exit remain mandatory. The broker must
own genuine pipe/PTY input, EOF and resize and preserve terminal foreground and
job-control semantics. A crashed keeper or unobserved supervisor remains unknown;
neither may fabricate a receipt or complete output capture.

Activation requires the native implementation, versioned contracts and database
fences, host outbox/inbox and replay adapters, output retention, and release
publisher/bootstrap qualification to agree on one exact protocol and artifact.
Router-shaped evidence must never be relabelled as broker evidence. The native
two-second cancellation, 35-second zombie observation and 100-repetition gates
remain unchanged. High-output, reconnect, stale writer, worker death, malformed
input, real PTY and keeper-credential sealed execution require physical proof.
Preservation-safe old-warm/checkpoint compatibility remains a separate gate.
