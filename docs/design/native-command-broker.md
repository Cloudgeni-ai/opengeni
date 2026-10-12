# Keeper-owned native command transport

Status: implementation in progress; not an admitted runtime capability. The
initial increment is an internal bounded wire codec and a native bootstrap
preflight with tests. It does not
enable new command starts, change a production protocol tuple, or qualify an
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

## Durable transport obligations

The pure input transitions in `native-command-broker-input.ts` serialize a
single pending input and require a committed dispatch intent before yielding
provider write bytes. A provider RPC acknowledgement does not clear that input.
Only the exact broker acceptance does. A replacement writer retains the old
pending epoch, index and body verbatim, resolves it, then appends its own fence
before any new command request. Modal 0.9.0 serializes the provider index as
`uint32`; the transitions refuse exhaustion rather than wrapping. Command EOF
is an encoded request and never closes the initial broker stdin.

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
partial-frame capture with the non-owner app role. No live command or provider
adapter invokes this journal yet. Canonical command admissions, bootstrap
binding, retention/purge lifecycle, and physical broker control remain required
before activation; an unresolved journal must not be deleted to unblock a lease
or workspace teardown.

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
