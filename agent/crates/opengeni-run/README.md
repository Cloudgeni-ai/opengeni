# opengeni-run

Experimental Linux command journal for [sandbox v2](../../../docs/design/sandbox-v2.md).
Ordinary provider exec calls reach this binary. It reuses the image's native
per-command subreaper; it needs no enrollment, application bus or global daemon.

`start` reads a JSON `StartRequest` from stdin. An immutable operation UUID binds
argv, cwd, environment digest, disk lineage and observed boot identity. Concurrent
or disconnected retries observe the original invocation. `read` returns separate
base64 byte pages and a terminal receipt only after all owned descendants stop
and both streams are durable. `cancel` retains monotonic cancellation; an
unavailable owner remains unknown. IDs and tombstones must never be reused.
Read and cancellation require the retained `--boot-id` and `--disk-lineage`. A changed
physical boot cannot create a fresh never-started tombstone for an old dispatch;
older unbound tombstones remain unknown. Boot fencing does not establish disk
history continuity after a same-boot rollback: the backend must revoke that lineage.

Optional `stdin: true` keeps a pipe open. `pty: { columns, rows }` instead creates
a controlling terminal and merges its output into stdout. `input` reads an
`InputRequest` with an immutable sequence starting at one: data in canonical
base64 (at most 4096 bytes), pipe close, or PTY resize. Identical retries resume
backpressure or replay the surviving owner's acceptance. Acceptance means bytes
queued into the OS stream, not processed by the application. A missing owner or
missing input history stays unknown; a PTY interrupted mid-write cannot claim
full acceptance. Input bytes live in volatile IPC; immutable input files contain
only sequence and digest. Commands and terminal echo may put their input in output.

`capabilities` probes actual kernel/subreaper/pipe/PTY support and reports the
kernel plus PID-1 identity. Launch credentials use consumed private tmpfs payloads;
the journal stores their digest. Guest root can edit its files, so this is recovery
evidence, not an authorization boundary. The control plane must retain dispatch
history and disk provenance outside the guest; restoring an older disk cannot
authorize repeating an old external effect.

Verify with `cargo test -p opengeni-run` and the finite Bun Linux suite:

```sh
docker build -f agent/crates/opengeni-run/tests/Dockerfile -t journal-conformance .
docker run --rm --network none journal-conformance
```

These commands run from the repository root, except Cargo from `agent/`.
Fixtures use synthetic data and require no provider account or model credentials.
The application v2 path remains disabled while integration is in progress.
