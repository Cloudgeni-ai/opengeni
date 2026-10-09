# Bash terminal input readiness

This Linux loadable builtin is the producer for `bash-readline-v1`. It preserves
the real `bash -l` startup sequence. It does not replace Bash, use `LD_PRELOAD`,
parse prompts, or treat a delay/banner/first output as readiness.

The stock ttyd launcher probes the installed addon with a clean non-login Bash
before advertising `opengeniInputReady=bash-readline-v1` in ttyd preferences.
Only that launch passes `OPENGENI_TERMINAL_READY` to each new shell. The image's
`/etc/profile.d/00-opengeni-terminal-ready.sh` removes the variable and registers
the callback before user login profiles. Ordinary shells do not load the addon.

The addon uses GNU Bash **5.2**'s packaged loadable headers and exported Readline
callback ABI. Builds against bookworm's 5.2 headers are additionally checked
against the **actual final runtime Bash** in both image Dockerfiles, on each
image target architecture. An ABI/version change requires explicit adaptation
and passing the native PTY tests; it must not silently advertise support.
The final image does not need a compiler or Bash development headers.

Registration emits `ESC ] 777;opengeni-input;hello;<32 lowercase hex> BEL`, with
a fresh 128-bit random identity for the PTY. The one-shot `rl_pre_input_hook`
chains the previous callback, then emits the matching `ready` frame only in its
own process, outside subshells and nested startup evaluation. Bash 5.2 invokes
this callback **after terminal preparation, startup hooks and prompt redisplay**,
immediately before the Readline input loop. `PROMPT_COMMAND` is too early.
Unload restores the previous callback rather than leaving a dangling pointer.

ttyd forwards this metadata on the current socket's output stream. The React
decoder strips it, binds READY to the first HELLO identity, resets on every
connection, and fences stale socket callbacks. These are cooperating terminal
protocol messages, not a security boundary against arbitrary same-privilege
code deliberately impersonating the protocol. The guarantee covers initial
Readline startup, not later explicit/asynchronous application input flushing.

## Compatibility and manual input

- Silent prompts work: READY is independent of visible output.
- Profiles/prompt commands which request input before startup completes, disabled
  line editing, replaced shells, redirected metadata, or an unloaded addon may
  never emit READY. The terminal explains that readiness is unestablished and
  offers **Use manual input**. This deliberately **discards** buffered typing
  before enabling unguaranteed input; it never executes the buffer as an answer
  to an unexpected startup prompt. A later READY does not replay it.
- Old images and already-running ttyd daemons do not advertise this contract.
  New clients retain their explicitly labelled legacy path. Unknown/malformed
  negotiation waits with the same manual escape, not a timeout fallback.
- Old clients ignore the OSC metadata and retain their old input semantics.
- Relay PTYs keep their separate existing OPEN_ACK/cursor contract unchanged.

No retry of a successfully dispatched command is introduced. Pending input is
bounded, ordered and sent once after readiness; socket send is not proof of
shell execution. Reconnect creates a new ttyd shell and a new readiness identity.
The group-global daemon retains its `/dev/null` Codemode token-file pointer.

Source merge alone does not fix existing boxes. Release needs the updated React
package/consumer and the matching sandbox image. Newly created boxes can acquire
the contract; already-running daemons/old images remain legacy. Rollback stops
advertising the capability for subsequent attachments; do not restart user
shells or replay input into a downgraded/replacement PTY.

## Checks

```sh
# Debian/Ubuntu build prerequisites: compiler, make, bash-builtins, Python 3
make -C agent/native/terminal-ready test
```

The tests create isolated homes and real PTYs, run unchanged login shells, and
verify octal-encoded execution markers (echo cannot pass). They cover profile
state preservation, silent prompts, startup and PS1 stdin flushes, startup reads,
subshell ownership, disabled Readline, unload, and fresh per-PTY identities.
Both stock images also run the suite with `--installed` against the real system
profile integration. Browser/hook regressions live in `packages/react/test/`;
the actual-component demo is `terminal.html?view=readiness` with
`mode=ready|silent|manual|legacy`.
