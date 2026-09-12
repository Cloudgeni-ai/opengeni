# Native transactional file uploads

The native upload path carries large replacement content in bounded control
messages without chunking directly into the destination. It is separate from
exec op streaming and from the legacy whole-message `FsWriteRequest`.

## Rollout and wire contract

Only select this path when the exact current Connected Machine capability
snapshot advertises `transactional_fs_write` (Capabilities field 14). Neither
`filesystem`, `op_stream`, a version guess, nor a previous connection's snapshot
is sufficient. Old runners leave this additive field false. The native platform
currently advertises it only on Linux; individual filesystem cases can still
return typed unsupported errors. There is no destructive fallback.

Use the authorized process-instance RPC subject and exact nonzero current epoch
for **every** begin, chunk, query, and cancel. Keep that scope, instance, epoch,
and upload ID throughout the transaction. Do not resolve a successor and reuse
the upload there. Each native WorkspaceLink owns an independent registry.

1. Choose a unique `fsw-` operation ID, normally `fsw-<UUID>`. IDs contain only
   ASCII letters, digits, hyphens, and underscores. The namespace is reserved:
   exec cannot start an operation with that prefix.
2. Send `OpStart.fs_write` using that ID as `ControlRequest.request_id`.
   Supply `path`, `content_digest` (64 lowercase BLAKE3 hex characters), and
   explicitly present `content_size` (including zero for an empty file).
   Supply exactly one of `expected_absent=true` and `expected_base_digest`.
   Stream windows, deadlines, and execution resource policies are unsupported.
3. Send one `WriteChunk` at a time. Start at `seq=0, offset=0`; subsequent
   values must equal `OpStatus.next_seq` and `write_offset`. Each body must fit
   the existing 512 KiB protocol chunk bound **and** the negotiated encoded
   transport payload bound, including envelope overhead. Non-final empty chunks
   are invalid; a final empty chunk supports empty content or explicit commit.
4. `last=true` verifies the entire staged size/digest and expected base before
   atomic publication. A successful chunk reply is `WriteChunkAck{seq}`.
5. `OpQuery` returns `OpStatus`. Upload `next_seq` is the next chunk sequence,
   not an output-frame sequence. `write_offset` is accepted byte progress.
   Successful terminal status is `Complete` with no cancellation/failure and
   `exit.digests["content"]` / `exit.totals["content"]` matching the intended
   digest and size. Verify the receipt before reporting success.

Uploads emit no `OpFrame`; do not subscribe for frames, send `OpAttach`, or
send `OpAck`. Query is the status/reconciliation interface. Sender-side request
timeouts are not transaction deadlines or proof of failure.

## Duplicates, failure, cancellation, and recovery

An exact repeated begin in the same registry returns the original status and
never opens or writes the destination again. A changed begin is refused.
Failed filesystem begins are retained as terminal failures, so a lost error
reply cannot cause the same ID to re-evaluate mutable preconditions.

Only an **exact most-recent chunk** replay is acknowledged, including a lost
final acknowledgement. Identity includes sequence, offset, length, last flag,
and the chunk digest. Changed duplicates, older sequences, out-of-order chunks,
and incorrect offsets are refused without advancing progress or touching the
destination. Retaining only one chunk fingerprint keeps per-upload replay state
constant-sized regardless of content length. No whole-content buffer is retained;
verification reads in 64 KiB blocks.

After an ambiguous acknowledgement, query that exact identity. A verified
terminal receipt proves commit; running progress permits explicit reconciliation
with the one in-flight chunk. Unknown/lost status is **not** permission to start
again. This protocol does not authorize blind retries or replacement IDs.

`OpCancel` serializes with chunks. Before commit it drops private staging and
returns a terminal cancelled status; cancellation before begin leaves a tombstone
that prevents a later begin. After commit it returns the committed receipt and
does not undo the write. A failed append, content verification, filesystem
precondition, or final authority check terminates the upload and drops staging.
Protocol ordering errors are rejected without advancing the live upload.

Errors are non-retryable `AgentError` values with stable `detail.failure_code`,
including `WRITE_CONFLICT`, `WRITE_DIGEST`, `WRITE_SIZE`, `WRITE_SEQUENCE`,
`WRITE_DUPLICATE`, `WRITE_UNKNOWN`, `WRITE_FENCED`, `WRITE_UNSUPPORTED`, and
`WRITE_IO`. Terminal failures repeat their code in `OpExit.failure_code`.
An unexpected handler failure or poisoned registry returns
`WRITE_OUTCOME_UNKNOWN`; it is not a retryable pre-commit failure.

Registry records last for that link's lifetime. A process restart or recreated
link loses its in-memory records; an unknown query returns
`Lost/AgentRestarted` (unknown, not evidence that no commit occurred). There is
no restart journal, durable exactly-once receipt, automatic re-begin, or orphan
adoption. Process death can leave a private `.opengeni-write-<UUID>` directory;
normal drop/cancel/failure removes only that transaction's exact private names.
No startup sweep infers ownership or removes another live transaction's staging.
An operator must establish that an orphan is no longer live before removing it.

## Filesystem semantics and limits

Paths use the native resolver (working-root-relative, absolute, or exact `~/`
expansion). Directory traversal uses retained directory handles and refuses
symlink components and parent traversal. Parent directories must already exist;
`create_parents=true` does not permit visible directory creation during staging.
Observed parent-directory replacement is a conflict.

Staging uses exclusive creation in a private mode-0700 directory under the
destination parent, on the same filesystem. A new file's ordinary mode honors
the requested mode or platform default and umask. Replacement preserves the
existing ordinary permission bits; the new inode must have matching ownership.
It does not preserve inode identity, timestamps, open-handle visibility, or
advisory locks: existing readers may continue reading the old inode after rename.

Supported cases are accessible single-link regular files on Linux ext4, XFS,
Btrfs, tmpfs, or overlayfs, subject to the actual rename/no-replace primitive
succeeding. Symlinks, hardlinks, special files/modes, extended attributes/ACLs,
nonordinary inode flags, mismatched ownership, setgid parent directories, network
or unrecognized filesystems, and unsupported platforms fail closed. Missing
permissions are not repaired, and no `runAs` or expanded host authority is implied.

For expected-absent creation, `renameat2(RENAME_NOREPLACE)` is the atomic
no-clobber publication primitive. An intervening creation causes a conflict,
never an overwrite. There is no exists-check/overwrite fallback.

For replacement, the runner checks the opened file's identity, ordinary
metadata, size, and content digest at begin and immediately before publication,
and refuses observed changes. This is an **optimistic expected-base check**, not
an atomic compare-and-swap against uncooperative external writers. An unrelated
writer can still race the final check and rename. Directory handles prevent
redirection, but do not turn the pathname into a filesystem transaction lock.

The staged file is synced before rename. Rename is the visible commit point;
the receipt is process-local, and no power-loss durability guarantee is made.
After publication, cleanup is not reported as a pre-commit failure that invites
another write. The upload introduces no host resource caps, workload throttles,
or automatic workload-stopping controls.

## Native verification

Synthetic filesystem fixtures and lifecycle tests live beside the implementation:

```sh
cd agent
cargo test --locked -p opengeni-agent-platform transactional_write
cargo test --locked -p opengeni-agent uploads::tests
```

Regenerate Rust protocol types with a Cargo build and TypeScript types with
`bash packages/agent-proto/scripts/codegen.sh` from the repository root. Rollout
also requires the runtime capability snapshot/negotiation and editor path to
use this exact schema, chunk bounds, stable identity, and verified receipt.

### Cross-language test fixture

`cargo build --locked -p opengeni-agent --example transactional-fs-fixture`
builds a disposable pipe bridge at `agent/target/debug/examples/transactional-fs-fixture`.
It is not an agent CLI command and is not built into the production agent.
Invoke it with an existing dedicated synthetic directory and a nonzero epoch.
Each stdin frame is a four-byte big-endian length followed by protobuf-encoded
`ControlRequest`; each stdout frame uses the same framing for `ControlResponse`.
Requests and responses have a 4 MiB **test framing** bound, independent of the
production transport's payload and chunk bounds. Stdout contains only frames;
diagnostics go to stderr. The process serves requests serially and owns one
registry; closing stdin drops its remaining private stages.

This lets a Bun editor test cross the real generated wire representation into
the production `Uploads` registry and `NativePlatform` storage implementation.
The fixture also forwards ordinary filesystem requests to `NativePlatform`
for the editor's reads/stat/move/remove operations. It does not expose exec,
enrollment, a network listener, new host privileges, or production authorization.
Use only synthetic inputs: this is a local test process, not a security boundary.