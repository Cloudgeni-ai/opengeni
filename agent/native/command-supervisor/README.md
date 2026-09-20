# Native command supervisor

`opengeni-command-supervisor capabilities` runs the same kernel-prerequisite
initialization as launch, creates no child or socket, prints exactly
`native-subreaper-v1`, and exits zero only on success. The control plane runs this
bounded check on the exact warm instance before admitting a supervised command.

Linux-only, single-threaded subreaper for the stock non-PTY sandbox image.
The image's existing `computer-native-build` stage cross-compiles and verifies
this libc-only executable; no Rust workspace dependency is added.

```sh
opengeni-command-supervisor launch --invocation UUID --nonce HEX64 \
  --socket /tmp/opengeni-supervision/UUID.sock -- /bin/sh -c 'command'
opengeni-command-supervisor control --invocation UUID --nonce HEX64 \
  --socket /tmp/opengeni-supervision/UUID.sock --action release
```

All identifiers are lowercase; the nonce is 32 random bytes encoded as 64 hex
digits. The socket's immediate parent is created mode 0700 if missing. It must
be owned by the executing UID, private, and resolve outside `/workspace`.
An existing socket is never replaced. The nonce is a local control credential,
not a hostile same-UID isolation boundary; do not log the argument vector.

Launch starts **idle** without a child. Persist launch authority before sending
`release`. `release` is idempotent and never launches again after cancellation
or natural completion. `cancel` is monotonic, sends TERM to discovered direct
children through pidfds, and sends KILL after 200 ms, repeatedly discovering
adopted children. No numeric PID signaling fallback exists.

`control --action status|release|cancel` prints one bounded JSON response:

```json
{"state":"idle"}
{"state":"running"}
{"state":"quiescent","receipt":{"protocol":"native-subreaper-v1","invocationId":"UUID","receiptId":"UUID","leaderExitCode":42}}
```

Cancellation still in progress is `running`. Only the all-child kernel
`waitpid(-1, ..., __WALL | WNOHANG)` result `ECHILD` permits quiescence, after
launch is permanently closed. A `WNOWAIT` observation opens each pidfd before
its corresponding reap. `SIGCHLD` is explicitly reset without `SA_NOCLDWAIT`.
The receipt remains immutable and replayable until
`control ... --action ack --receipt UUID`. ACK requires the exact receipt ID
and returns the same quiescent response. Persist proof before ACK. The helper
may lose its ACK response even though the supervisor has accepted ACK and exited.

The leader's exit code is its shell exit status or `128 + signal`; cancelling
idle uses 125 to mean **never launched** (not an actual leader exit). Supervisor
exit is independently 0 after ACK. Errors exit 125 without proof. A crash,
unsupported primitive, lost control, or provider loss is not quiescence.
Never infer proof from exit status, EOF, or the launched command's stdout.
Only the separate trusted `control` invocation prints protocol JSON; launch
stdin/stdout/stderr remain user data. User children close control descriptors.

Internal wire transport is Unix `SOCK_SEQPACKET`, one bounded request per
connection: five tab-separated fields `native-subreaper-v1`, invocation UUID,
nonce, action, and receipt UUID (or `-` for non-ACK). One packet holds the JSON
response. Invalid identity/action/receipt returns an error, never a receipt.

This covers ordinary descendants while the supervisor survives, including
double-fork and `setsid`. It does not contain hostile same-privilege code or
work handed to existing external daemons. It uses no PID namespace. PTY,
`runAs`, other images/providers and the exact Modal image require separate
conformance testing; this implementation alone licenses no checkpoint claim.

Run local native tests (Linux, C compiler, make, Python 3):

```sh
make -C agent/native/command-supervisor test CFLAGS='-O2 -g'
```

The native CI job runs the same tests. Finite adversarial fixtures test leader
exit before descendants, double-fork/setsid, TERM ignoring, forks during cancel,
clone children (including a direct zero-signal clone), inherited SIGCHLD state,
receipt replay/ACK loss, authentication, closed control descriptors, supervisor
crash, stale pidfds and seccomp-denied primitives. Build outputs stay ignored.