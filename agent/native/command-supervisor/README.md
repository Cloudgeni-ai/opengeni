# Native command supervisor

`opengeni-command-supervisor capabilities` runs the same kernel-prerequisite
initialization as launch, creates no child or socket, prints exactly
`native-subreaper-v1`, and exits zero only on success. The control plane runs this
bounded check on the exact warm instance before admitting a supervised command.

Linux-only, single-threaded subreaper for the stock sandbox image.
Desktop and server images build the same static musl ELF using
`build-static.sh` at `/src/supervisor.c`; no Rust workspace dependency is added.
The script checks the architecture, size limit and absence of an ELF interpreter
or dynamic segment without executing the target binary on the build host.

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
If the kernel does not implement `TIOCGDEV` (`ENOTTY` only), identity instead
requires `/dev/tty` and all three streams to expose the exact same character
device inode (device, inode and character-device identity). A proxy inode,
different PTY, or denied identity ioctl still fails closed. Every stream must
also belong to the supervisor's existing session and foreground process group.

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

## Private inherited broker channel (not activated)

`launch-channel --control-fd FD --invocation UUID --nonce HEX64 [--pty] -- COMMAND...`
is an internal primitive for the initial broker, not a replacement path selected
after ordinary control fails. It accepts only an inherited, connected, unnamed
Unix `SOCK_SEQPACKET` pair whose creation credentials match the direct parent.
The broker must itself own authenticated initial-process custody; the creation
credentials are a topology check, not proof of the current sender, an arbitrary
guest's identity, or hostile same-UID containment. This primitive is not yet
connected to provider execution or host command admission.

The channel is persistent and uses `native-subreaper-broker-channel-v1` or
`native-subreaper-broker-channel-pty-v1`, with the same five-field request and
receipt fields as the existing path protocol. No filesystem socket is created.
One nonblocking bounded response accompanies each request; the broker must keep
reading replies. A full response queue, receive EOF or channel error closes
launch, cancels/drains all owned descendants through the normal pidfd/subreaper
path, restores the PTY after ECHILD, then exits **125**, never clean ACK success.
A closed peer wins over a queued release. There is no receipt inferred from
that exit or from stream EOF. As before, only the exact acknowledged receipt
permits exit 0. User children never inherit the control descriptor.

The tests cover persistent replay/authentication, malformed/oversized packets,
half-close and full-close, response backpressure, detached and TERM-ignoring
descendants, strict descriptor topology, real PTY job control and inherited
signal/descriptor hygiene. These tests do not qualify the complete broker or a
provider's command ownership contract.

The in-progress broker's literal command-definition decoder lives beside this
primitive. Its binary format and bounds are described in
[the broker design](../../../docs/design/native-command-broker.md#literal-command-definitions).
It is not a production CLI mode and starts no process. Native tests use a
separate parser/round-trip executable, including malformed Unicode, length,
environment and aggregate-bound cases. With Bun installed, the explicit
`make test-definition-parity` target compares it against the real runtime codec.

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

## Sealed artifact keeper

The proposed keeper-owned broker is a separately versioned implementation in
progress, described in [its design](../../../docs/design/native-command-broker.md).
Its bounded host-side framing codec and native `broker-preflight --broker-id UUID`
probe do not activate a broker, change the existing keeper behavior, or qualify
any runtime command. The explicit preflight runs fixed sealed-ELF inspection and
pipe/PTY capability children with `execveat(AT_EMPTY_PATH)` under the initial
process, emits bounded artifact frames only after exact-byte/identity and
independent-exit checks, and reports `commandAdmission: false`. It accepts no
user command and makes no provider, cancellation or snapshot-preservation claim.
The static test target includes its positive and denied-syscall regressions.

The keeper is a separate initializer for a newly created physical sandbox. It
must be the trusted initial executable before any user setup. It requires UID 0
and a static ELF, creates no child, installs no subreaper, and changes no session,
process group or terminal state. It does not claim ownership of user jobs. When
it is namespace PID 1, normal kernel orphan adoption still applies; its boot
facts are not a descendant-drain receipt.

```sh
/.hHEX64 keeper --source-sha SOURCE40 --artifact-sha256 SHA256 \
  --control-dir /.cHEX64
```

Both root names must come from fresh 256-bit host randomness after the immutable
filesystem snapshot exists. The delivered ELF opens its actual `/proc/self/exe`,
copies at most 256 KiB to an executable memfd, and seals WRITE, GROW, SHRINK and
SEAL. Permission or execution-policy denial fails closed; there is no loader,
chmod or unsealed-file fallback. Only `EINVAL` for the newer `MFD_EXEC` flag
permits the old-kernel flag form, which must still yield an executable sealed
memfd. The control directory is created exclusively with mode 0700 and no
symlink following. Existing directories, files or symlinks are rejected.

The keeper emits one boot JSON line with protocol `native-artifact-keeper-v1`,
state `idle`, `sourceSha`, `artifactSha256`, `keeperPid`, `artifactFd`, `seals`,
`byteSize`, `target`, decimal-string `device` and `inode`, `controlDirectory` and
`artifactPath`. The artifact path is `/proc/KEEPER_PID/fd/FD`. Source SHA and
artifact SHA are host-supplied declarations, not attestation. Before any manifest
or user setup, the host must execute that FD path with `artifact-capabilities`
and `artifact-bytes --base64`, and hash the actual returned ELF bytes against its
authenticated original artifact. Do not forward these bytes or boot/control
facts into user streams.

`artifact-capabilities` inspects the executing sealed ELF and prints its actual
size, seals, target, static status, device and inode. `artifact-bytes --base64`
returns only base64 of those actual sealed bytes. Both reject ordinary unsealed
filesystem executables. Later capability, launch and control calls use the
retained FD path; replacing the guest's original root file does not change it.
Every reconnect must validate the original keeper/FD identity, seals and size.
A missing keeper or mismatch is uncertainty, never permission to select a new
artifact or rewrite the original source binding. A UUID socket ending `.s`
inside the root control directory is 106 bytes, within Linux AF_UNIX limits.

INT and HUP leave the keeper alive. TERM closes its retained FD and removes only
its own marker and the same empty directory; it never removes invocation sockets.
Provider stop remains responsible for physical sandbox termination. No keeper
exit, boot line or capability response proves command quiescence.

API and worker images retain a root-owned readonly source, ELF and measured
manifest under `/opt/opengeni`, bound to the baked `/opt/opengeni/source-sha`.
`@opengeni/config/server-native-artifact` reads only those fixed paths, verifies
attributes and actual hashes, and returns opaque reader authority with defensive
byte access. Server roles never execute this host ELF. Matching source or version
labels alone do not select artifact bytes, and future source changes must retain
the original exact artifact separately until its retained references settle.
This foundation does not implement provider delivery, artifact retention,
qualified-image selection or runtime admission.

Run the keeper tests against a static build in a task-owned root namespace:

```sh
make -C agent/native/command-supervisor test-static BUILD=BUILD_DIRECTORY
```

This requires musl-gcc, the ordinary fixture compiler and Python 3. The existing
`test` target remains unchanged; `test-static` also requires UID 0 explicitly.
They check actual-byte hashing, immutable seals, path replacement and FD
reconnection, exclusive paths, UID and execution-policy denials, TERM cleanup,
and genuine interactive Bash launch/control through the retained ELF.
