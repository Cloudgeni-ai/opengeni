"""Real PTY/login-shell contract tests; no prompt/output heuristics or mocked Bash.

With --installed, also proves the final image's profile bootstrap and Bash ABI.
Execution markers are octal-encoded so terminal echo cannot satisfy assertions.
"""
import errno
import os
from pathlib import Path
import re
import select
import shlex
import signal
import subprocess
import sys
import tempfile
import time

addon = str(Path(sys.argv[1]).resolve())
installed = "--installed" in sys.argv
bootstrap = None if installed else Path(__file__).resolve().parents[4] / "docker/desktop/opengeni-terminal-ready.sh"
frame = re.compile(rb"\x1b\]777;opengeni-input;(hello|ready);([a-f0-9]{32})\x07")
flush = "python3 -c 'import termios; termios.tcflush(0, termios.TCIFLUSH); print(\"FLUSH_COMPLETE\")'"
fixtures = {
    "normal": "PROMPT_COMMAND=':'; PS1='custom> '",
    "silent": "PS1= PS2=; bind 'set enable-bracketed-paste off'",
    "startup-flush": "printf 'STARTUP_BANNER\\n'; sleep 0.1; " + flush,
    "prompt-flush": "PS1=\"\\$(" + flush.replace('"', '\\"') + ") prompt> \"",
    "startup-read": "IFS= read -r -e -p 'Configuration: ' answer",
    "no-editing": "set +o emacs; set +o vi; PS1= PS2=",
    "unloaded": "enable -d opengeni_terminal_ready",
    "subshell-read": "( IFS= read -r -e -p 'Subshell configuration: ' answer )",
}

def trial(name, profile):
    with tempfile.TemporaryDirectory(prefix="opengeni-ready-") as root:
        folder = Path(root)
        load = ""
        if not installed:
            local_bootstrap = folder / "bootstrap.sh"
            local_bootstrap.write_text(bootstrap.read_text().replace(
                "/usr/local/lib/opengeni/opengeni-terminal-ready.so", shlex.quote(addon)))
            load = ". " + shlex.quote(str(local_bootstrap)) + "\n"
        (folder / ".bash_profile").write_text(
            load + "LOCAL_PROFILE_VALUE=preserved; export EXPORTED_PROFILE_VALUE=preserved\n"
            + "printf 'PROFILE_LOADED\\n'\n" + profile + "\n")
        pid, fd = os.forkpty()
        if pid == 0:
            os.execve("/bin/bash", ["bash", "-l"], {
                "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": root,
                "TERM": "xterm-256color", "LC_ALL": "C",
                "HISTFILE": "/dev/null",
                "OPENGENI_TERMINAL_READY": "bash-readline-v1",
            })
        output = bytearray()
        def collect(seconds, predicate=lambda: False):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline and not predicate():
                if not select.select([fd], [], [], min(0.025, max(0, deadline-time.monotonic())))[0]:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not chunk:
                    return
                output.extend(chunk)
        def frames():
            return frame.findall(output)
        def ready():
            values = frames()
            return len(values) >= 2 and values[0][0] == b"hello" and values[1] == (b"ready", values[0][1])
        try:
            supported = name not in {"startup-read", "no-editing", "unloaded", "subshell-read"}
            collect(3 if supported else 0.4, ready)
            assert ready() == supported, (name, "initial readiness", bytes(output))
            before_manual = bytes(output)
            if name in {"startup-read", "subshell-read"}:
                os.write(fd, b"configuration-value\n")
                collect(3, ready)
                assert ready(), (name, "manual startup completion", bytes(output))
            marker = "EXECUTED_" + name
            encoded = "".join("\\%03o" % ord(c) for c in marker)
            command = "printf '" + encoded + "\\n'; printf 'STATE:%s|%s|%s|%s\\n' \"$LOCAL_PROFILE_VALUE\" \"$EXPORTED_PROFILE_VALUE\" \"$(shopt -q login_shell && printf login)\" \"${OPENGENI_TERMINAL_READY-unset}\"\n"
            os.write(fd, command.encode())
            collect(3, lambda: b"STATE:preserved|preserved|login|unset" in output)
            assert marker.encode() in output, (name, "execution", bytes(output))
            assert b"STATE:preserved|preserved|login|unset" in output, (name, "profile/environment state", bytes(output))
            assert output.count(b"PROFILE_LOADED") == 1, (name, "profile ran more than once")
            expected = 0 if name in {"no-editing", "unloaded"} else 1
            assert sum(event == b"ready" for event, _ in frames()) == expected, (name, frames())
            assert b"symbol lookup error" not in output, (name, "child ABI contamination")
            if name in {"startup-flush", "prompt-flush"}:
                assert b"FLUSH_COMPLETE" in before_manual, (name, "flush did not execute")
                assert before_manual.index(b"FLUSH_COMPLETE") < before_manual.index(b";ready;"), (name, "premature READY")
            identity = frames()[0][1]
            print("PASS", name, "ready" if expected else "manual-only", flush=True)
            return identity
        finally:
            os.close(fd)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)

subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c",
                'enable -f "$1" opengeni_terminal_ready && opengeni_terminal_ready --probe',
                "probe", addon], check=True)
identities = [trial(name, profile) for name, profile in fixtures.items()]
assert len(set(identities)) == len(identities), "PTY identities must be fresh"
print("PASS supported Bash ABI, fresh PTY identities, login startup, silent prompts, manual escape")
