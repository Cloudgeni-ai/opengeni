# Native command supervisor

`opengeni-command-supervisor capabilities` runs the same kernel-prerequisite
initialization as launch, creates no child or socket, prints exactly
`native-subreaper-v1`, and exits zero only on success. The control plane runs this
bounded check on the exact warm instance before admitting a supervised command.

Linux-only, single-threaded subreaper for the stock sandbox image.
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

PTY commands use the distinct `native-subreaper-pty-v1` protocol. Select it with
`launch --pty`, `control --pty`, and `capabilities --pty`. The control helper
still runs separately without a PTY. Capability preflight and launch require
all three inherited standard streams to be the same foreground controlling
terminal in the supervisor's existing session. A pipe, redirected stream,
background wrapper, or denied terminal-control ioctl fails closed before user
code. PTY preflight prints exactly `native-subreaper-pty-v1` without a newline.
It exercises the terminal handoff and attribute-restoration ioctls with the
current foreground group and unchanged attributes, creating no child or socket.

The child enters its own process group before restoring default terminal signal
dispositions and an empty signal mask. A two-way pipe barrier keeps it from
executing until the supervisor has transferred the terminal foreground to that
group. Parent readiness and release ends are nonblocking; a stopped child cannot
block status or authenticated cancellation. A setup failure, failed terminal
handoff, or terminal signal at the barrier closes release, drains the owned
child through the same pidfd/reaper path, and retains proof without executing
user code. The supervisor ignores terminal signals, including HUP, INT, QUIT,
TSTP, TTIN and TTOU, and retains the provider's controlling terminal. It never
uses `setsid` or `TIOCSCTTY`, disables job control, or signals numeric process
groups. Interactive Bash can create, stop and resume genuine foreground jobs;
terminal resize signaling goes directly to the active foreground group.
After kernel ECHILD the supervisor restores the original foreground group and
terminal attributes before constructing the PTY receipt. Restoration failure
exits without proof. The receipt uses the PTY protocol name with the same
identity, replay and ACK semantics as the non-PTY protocol.

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
connection: five tab-separated fields selected protocol, invocation UUID,
nonce, action, and receipt UUID (or `-` for non-ACK). One packet holds the JSON
response. Invalid identity/action/receipt returns an error, never a receipt.

This covers ordinary descendants while the supervisor survives, including
double-fork and `setsid`. It does not contain hostile same-privilege code or
work handed to existing external daemons. It uses no PID namespace. PTY is
implemented and tested against a real inherited `forkpty` terminal locally;
`runAs`, other images/providers and the exact Modal image still require separate
conformance testing; this implementation alone licenses no checkpoint claim.

`service -- COMMAND...` is the placement-service mode. It launches immediately,
forwards TERM/INT to the leader, and allows 30 seconds for graceful shutdown.
Leader exit triggers descendant TERM followed by KILL after 200 ms. It exits
with the leader status only after kernel ECHILD; it creates no command receipt
or control socket. This mode is for browserd, whose detached descendants must
not outlive its controller. Retained-command `launch` semantics are unchanged.

Run local native tests (Linux, C compiler, make, Python 3):

```sh
make -C agent/native/command-supervisor test CFLAGS='-O2 -g'
```

The native CI job runs the same tests. Finite adversarial fixtures test leader
exit before descendants, double-fork/setsid, TERM ignoring, forks during cancel,
clone children (including a direct zero-signal clone), inherited SIGCHLD state,
receipt replay/ACK loss, authentication, closed control descriptors, supervisor
crash, stale pidfds and seccomp-denied primitives. Build outputs stay ignored.
PTY fixtures additionally exercise interactive Bash foreground groups,
Ctrl-C/Ctrl-Z/`fg`, resizing, ignored-TERM and detached descendants, exact
termios restoration, terminal capability failures, protocol authentication,
descriptor and signal inheritance, receipt replay/ACK loss and crash without
proof. Native test-only wrappers inject Ctrl-C precisely between handoff and
release, handoff failure, and a stopped child before readiness. They preserve
natural leader-exit semantics while descendants remain.
