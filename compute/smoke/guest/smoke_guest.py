#!/usr/bin/env python3
"""Reference guest service for the compute smoke suite.

Runs inside a sandbox and answers one JSON request per connection, arriving
through the host agent's `connect` stream on a vsock port. It gives the smoke
scenarios what an E2B-style data plane offers: commands, background processes
that outlive their connection, files, and a recursive directory watcher.

Protocol: the client sends one JSON object on one line; the service answers
with one JSON line, `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.
A `watch` answer is followed by one JSON line per filesystem event until the
client closes the connection. Binary data travels base64-encoded.

Standard library only, so it runs on any guest with Python 3.10 or later.
Background processes live in this process's memory: they survive pausing,
saving and restoring the sandbox, and are gone after a fresh boot, exactly
like the programs themselves.

With `--notice`, the service also answers the host agent's restore notice
(`restored <unix time in nanoseconds> [key=value ...]`): it sets the clock,
counts restores, takes the `sandbox=<id>` field as its own sandbox id, mixes
the `seed=<hex>` field into the kernel's random number generator and reseeds
it, and ignores fields it does not know. It answers `ok seeded` when it
applied a seed and `ok` otherwise; the host uses a clone of a template or a
ready sandbox only after `ok seeded`, since until then it draws the same
random numbers as every other clone of the same snapshot. `ping` reports both, so a
scenario can tell that its sandbox was restored from a memory image, and
which sandbox a guest started from a template believes it is. The host
retries a notice whose answer got lost, so the count can run ahead of the
restores. The id is kept in the state directory before the answer, so a
restarted service still knows it; a guest booted from its disk finds its id
on the kernel command line instead, as `opengeni.sandbox=<id>`.

Notices are applied one at a time, in the host's order: the
`order=<generation>.<revision>` field, which the host raises before every new
notice and never lowers. One ordered below the latest applied (an attempt the
host gave up on that arrived late) is refused, whatever its time says, so it
can never take back a newer identity, even after the host's clock stepped
back; a retry of the same notice is applied again. The time only sets the
clock. A notice without the field is applied without being ordered.

A notice naming a sandbox other than the one the guest believes it is comes
to a clone: before taking the id, the service gives the guest a machine id
of its own (from the seed and the id, so a retried notice writes the same)
and the id as its hostname, and answers `ok` rather than `ok seeded` when it
cannot, so two clones never share either.

A background command's output can be read from a cursor (`output`) while
it runs: a client whose connection dropped, for example because the host
agent restarted, resumes where it stopped. Live connections such as a
`watch` or an `exec` under way end with the host agent and are not resumed.
Everything here lives in this service's memory, so a restart of the service
itself forgets its background commands, though they keep running.

Commands started here keep the sandbox awake while they run, however quiet
they are: asked `activity` on the notice port, the service answers
`commands <n>`, the number still running. A request with `"keep_awake":
false` starts one that does not count (fire and forget).

The service sets its own `oom_score_adj` to -1000, so when the guest runs
out of memory the kernel kills the user's programs before it; every command
it starts resets the inherited setting to 0 before running.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import ctypes.util
import fcntl
import hashlib
import itertools
import json
import math
import os
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, BinaryIO

MAX_REQUEST = 64 << 20
# Room for the time, the sandbox id and fields a later host may add.
MAX_NOTICE = 1024
SANDBOX_ARG = "opengeni.sandbox"
RANDOM_DEVICE = "/dev/urandom"
RNDRESEEDCRNG = 0x5207  # _IO('R', 0x07)
OUTPUT_DIR = Path(os.environ.get("SMOKE_GUEST_STATE", "/run/smoke-guest"))
# Where a sandbox's own machine id and hostname go.
MACHINE_ID = Path(os.environ.get("SMOKE_GUEST_MACHINE_ID", "/etc/machine-id"))
# The sandbox the machine id was made for. It lives on the disk beside the
# machine id, so a disk cloned from a template still names the template.
IDENTITY = Path(os.environ.get("SMOKE_GUEST_IDENTITY", "/etc/opengeni-identity"))
HOSTNAME = Path(os.environ.get("SMOKE_GUEST_HOSTNAME", "/proc/sys/kernel/hostname"))
_HOSTNAME_LABEL = re.compile(r"[0-9A-Za-z][0-9A-Za-z-]{0,62}")
# The id the latest restore notice gave, kept across restarts of the service.
SANDBOX_FILE = OUTPUT_DIR / "sandbox"
_OUTPUT_NAMES = itertools.count()
OOM_SCORE_ADJ = Path("/proc/self/oom_score_adj")
# Runs `$1` with the out-of-memory killer's default view of it, not the
# service's; quiet where there is no such setting (outside Linux).
_USER_COMMAND = 'echo 0 2>/dev/null > /proc/self/oom_score_adj; exec /bin/bash -c "$1" /bin/bash'


def _user_command(command: str) -> list[str]:
    """The program and arguments that run a user's shell `command`."""

    return ["/bin/sh", "-c", _USER_COMMAND, "sh", command]


def _oom_score_adj() -> int | None:
    try:
        return int(OOM_SCORE_ADJ.read_text())
    except (OSError, ValueError):
        return None


def _outlast_user_programs() -> None:
    """Asks the kernel to kill anything else first when memory runs out."""

    try:
        OOM_SCORE_ADJ.write_text("-1000")
    except OSError as error:
        print(f"smoke guest: cannot protect itself from the OOM killer: {error}", file=sys.stderr)


class RequestError(Exception):
    """The request cannot be served; the message goes back to the client."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def _field(request: dict[str, Any], name: str, kind: type | tuple[type, ...]) -> Any:
    value = request.get(name)
    # JSON true and false are never numbers here.
    if (isinstance(value, bool) and kind is not bool) or not isinstance(value, kind):
        kinds = kind if isinstance(kind, tuple) else (kind,)
        expected = " or ".join(k.__name__ for k in kinds)
        raise RequestError(f"field {name!r} must be {expected}")
    return value


def _optional(
    request: dict[str, Any], name: str, kind: type | tuple[type, ...], default: Any
) -> Any:
    return default if request.get(name) is None else _field(request, name, kind)


def _environment(request: dict[str, Any]) -> dict[str, str]:
    extra = _optional(request, "env", dict, {})
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in extra.items()):
        raise RequestError("field 'env' must map strings to strings")
    return {**os.environ, **extra}


class Process:
    """One background command, with its output kept in files."""

    def __init__(
        self, command: str, env: dict[str, str], cwd: str | None, *, keep_awake: bool = True
    ) -> None:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self.command = command
        self.keep_awake = keep_awake
        name = f"{os.getpid()}-{next(_OUTPUT_NAMES)}"
        self._stdout = (OUTPUT_DIR / f"{name}.out").open("w+b")
        self._stderr = (OUTPUT_DIR / f"{name}.err").open("w+b")
        self.popen = subprocess.Popen(
            _user_command(command),
            stdin=subprocess.DEVNULL,
            stdout=self._stdout,
            stderr=self._stderr,
            env=env,
            cwd=cwd,
            start_new_session=True,
        )
        self.pid = self.popen.pid
        self.exited = threading.Event()
        threading.Thread(target=self._reap, name=f"reap-{self.pid}", daemon=True).start()

    def _reap(self) -> None:
        self.popen.wait()
        self.exited.set()

    def output(self, stream: str, offset: int, limit: int) -> bytes:
        """Up to `limit` bytes of `stream` (`stdout` or `stderr`) from
        `offset` on, so a client that lost its connection, or whose host
        agent restarted, resumes where it stopped."""

        file = {"stdout": self._stdout, "stderr": self._stderr}.get(stream)
        if file is None:
            raise RequestError("field 'stream' must be 'stdout' or 'stderr'")
        file.flush()
        return os.pread(file.fileno(), limit, offset)

    def result(self) -> dict[str, Any]:
        stdout = _read_all(self._stdout)
        stderr = _read_all(self._stderr)
        return {
            "exit_code": self.popen.returncode,
            "stdout": _b64(stdout),
            "stderr": _b64(stderr),
        }

    def discard(self) -> None:
        for stream in (self._stdout, self._stderr):
            name = stream.name
            stream.close()
            Path(name).unlink(missing_ok=True)


def _read_all(stream: BinaryIO) -> bytes:
    stream.flush()
    stream.seek(0)
    return stream.read()


class Processes:
    """Background commands started through this service, by pid."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_pid: dict[int, Process] = {}

    def start(
        self, command: str, env: dict[str, str], cwd: str | None, *, keep_awake: bool = True
    ) -> Process:
        process = Process(command, env, cwd, keep_awake=keep_awake)
        with self._lock:
            self._by_pid[process.pid] = process
        return process

    def get(self, pid: int) -> Process:
        with self._lock:
            process = self._by_pid.get(pid)
        if process is None:
            raise RequestError(f"no process {pid} was started here")
        return process

    def running(self) -> list[Process]:
        with self._lock:
            return [p for p in self._by_pid.values() if not p.exited.is_set()]

    def unwaited(self) -> list[Process]:
        """Every process not yet collected by `wait`, running or not."""

        with self._lock:
            return list(self._by_pid.values())

    def forget(self, pid: int) -> None:
        with self._lock:
            process = self._by_pid.pop(pid, None)
        if process is not None:
            process.discard()


PROCESSES = Processes()


class Running:
    """Foreground commands (`exec`) under way that keep the sandbox awake."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._count = 0

    @contextlib.contextmanager
    def one(self, keep_awake: bool) -> Any:
        with self._lock:
            self._count += keep_awake
        try:
            yield
        finally:
            with self._lock:
                self._count -= keep_awake

    def count(self) -> int:
        with self._lock:
            return self._count


EXECS = Running()


def awake_commands() -> int:
    """Commands started here that still run and keep the sandbox awake."""

    background = sum(1 for process in PROCESSES.running() if process.keep_awake)
    return background + EXECS.count()


class Restores:
    """How many restore notices this service has acknowledged, and which
    sandbox the latest one (or the kernel command line) said it is. A new id
    is written to SANDBOX_FILE before it counts, so it outlives the
    service."""

    def __init__(self, sandbox: str | None) -> None:
        self._lock = threading.Lock()
        self._count = 0
        self._sandbox = sandbox

    def record(self, sandbox: str | None) -> None:
        with self._lock:
            if sandbox is not None and sandbox != self._sandbox:
                _keep_sandbox(sandbox)
            self._count += 1
            if sandbox is not None:
                self._sandbox = sandbox

    def count(self) -> int:
        with self._lock:
            return self._count

    def sandbox(self) -> str | None:
        with self._lock:
            return self._sandbox


def boot_sandbox(cmdline: str) -> str | None:
    """The sandbox id the host put on a kernel command line, if any."""

    for word in cmdline.split():
        key, equals, value = word.partition("=")
        if equals and key == SANDBOX_ARG and value:
            return value
    return None


def _keep_sandbox(sandbox: str) -> None:
    """Writes `sandbox` to SANDBOX_FILE, replacing it whole."""

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    staged = SANDBOX_FILE.with_name(f".{SANDBOX_FILE.name}.{os.getpid()}")
    staged.write_text(sandbox, encoding="ascii")
    os.replace(staged, SANDBOX_FILE)


def _starting_sandbox() -> str | None:
    """The id a starting service takes: the one a restore notice gave an
    earlier run of the service, else the kernel command line's."""

    try:
        kept = SANDBOX_FILE.read_text(encoding="ascii").strip()
    except OSError:
        kept = ""
    if kept:
        return kept
    try:
        return boot_sandbox(Path("/proc/cmdline").read_text(encoding="ascii", errors="replace"))
    except OSError:
        return None


RESTORES = Restores(_starting_sandbox())


def op_ping(_request: dict[str, Any]) -> dict[str, Any]:
    return {
        "pid": os.getpid(),
        "restores": RESTORES.count(),
        "sandbox": RESTORES.sandbox(),
        "oom_score_adj": _oom_score_adj(),
    }


def op_exec(request: dict[str, Any]) -> dict[str, Any]:
    command = _field(request, "command", str)
    timeout = _optional(request, "timeout", (int, float), None)
    keep_awake = _optional(request, "keep_awake", bool, True)
    with EXECS.one(keep_awake):
        process = subprocess.Popen(
            _user_command(command),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_environment(request),
            cwd=_optional(request, "cwd", str, None),
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            raise RequestError(f"command timed out after {timeout}s") from None
    return {
        "exit_code": process.returncode,
        "stdout": _b64(stdout),
        "stderr": _b64(stderr),
    }


def op_spawn(request: dict[str, Any]) -> dict[str, Any]:
    process = PROCESSES.start(
        _field(request, "command", str),
        _environment(request),
        _optional(request, "cwd", str, None),
        keep_awake=_optional(request, "keep_awake", bool, True),
    )
    return {"pid": process.pid}


def op_processes(request: dict[str, Any]) -> dict[str, Any]:
    """Running background commands; with `all`, also those that ended but
    whose result no `wait` has collected yet."""

    every = request.get("all", False)
    if not isinstance(every, bool):
        raise RequestError("field 'all' must be bool")
    processes = PROCESSES.unwaited() if every else PROCESSES.running()
    return {
        "processes": [
            {
                "pid": process.pid,
                "command": process.command,
                "running": not process.exited.is_set(),
            }
            for process in processes
        ]
    }


def op_signal(request: dict[str, Any]) -> dict[str, Any]:
    """Signals a background command's whole process group, so children it
    started do not outlive a kill. Reports whether the command itself was
    still running to receive it."""

    pid = _field(request, "pid", int)
    number = _field(request, "signal", int)
    process = PROCESSES.get(pid)
    if process.exited.is_set():
        # Reaped already, so its group id may belong to someone else now.
        return {"delivered": False}
    try:
        # The command was started in a new session, so its pid is the group.
        os.killpg(pid, number)
    except ProcessLookupError:
        return {"delivered": False}
    return {"delivered": True}


def op_wait(request: dict[str, Any]) -> dict[str, Any]:
    """Waits for a background process and returns its output and status."""

    pid = _field(request, "pid", int)
    timeout = _optional(request, "timeout", (int, float), None)
    process = PROCESSES.get(pid)
    if not process.exited.wait(timeout):
        raise RequestError(f"process {pid} still running after {timeout}s")
    result = process.result()
    if request.get("forget", True):
        PROCESSES.forget(pid)
    return result


def op_output(request: dict[str, Any]) -> dict[str, Any]:
    """A background command's output from a cursor: the bytes from
    `offset` on (at most `limit`), the cursor after them, whether the
    command still runs, and `eof`: whether these bytes are the last, as it
    ended and wrote nothing after them. A reader drains until `eof`, not
    until the command stops running: a command that ended may have left
    more than one read's worth. Output stays readable until `wait` collects
    it."""

    process = PROCESSES.get(_field(request, "pid", int))
    offset = _optional(request, "offset", int, 0)
    limit = _optional(request, "limit", int, 1 << 20)
    if offset < 0 or not 0 < limit <= MAX_REQUEST:
        raise RequestError("field 'offset' or 'limit' out of range")
    stream = _optional(request, "stream", str, "stdout")
    # Read whether it ended first: output read after it ended is complete.
    ended = process.exited.is_set()
    data = process.output(stream, offset, limit)
    after = offset + len(data)
    eof = ended and not process.output(stream, after, 1)
    return {"data": _b64(data), "offset": after, "running": not ended, "eof": eof}


def op_read(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(_field(request, "path", str))
    try:
        return {"data": _b64(path.read_bytes())}
    except FileNotFoundError:
        raise RequestError(f"no such file: {path}") from None


def op_write(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(_field(request, "path", str))
    data = _unb64(_field(request, "data", str))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"bytes": len(data)}


def op_mkdir(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(_field(request, "path", str))
    created = not path.is_dir()
    path.mkdir(parents=True, exist_ok=True)
    return {"created": created}


def op_exists(request: dict[str, Any]) -> dict[str, Any]:
    return {"exists": os.path.lexists(_field(request, "path", str))}


def op_list(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(_field(request, "path", str))
    if not path.is_dir():
        raise RequestError(f"not a directory: {path}")
    entries = []
    for entry in sorted(os.scandir(path), key=lambda entry: entry.name):
        kind = "dir" if entry.is_dir(follow_symlinks=False) else "file"
        entries.append({"name": entry.name, "path": entry.path, "type": kind})
    return {"entries": entries}


def op_rename(request: dict[str, Any]) -> dict[str, Any]:
    source = Path(_field(request, "source", str))
    target = Path(_field(request, "target", str))
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, target)
    return {}


def op_remove(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(_field(request, "path", str))
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
    return {}


# inotify(7) event bits used by the watcher.
IN_MODIFY = 0x002
IN_ATTRIB = 0x004
IN_CLOSE_WRITE = 0x008
IN_MOVED_FROM = 0x040
IN_MOVED_TO = 0x080
IN_CREATE = 0x100
IN_DELETE = 0x200
IN_DELETE_SELF = 0x400
IN_IGNORED = 0x8000
IN_ISDIR = 0x40000000
WATCHED = (
    IN_MODIFY
    | IN_ATTRIB
    | IN_CLOSE_WRITE
    | IN_MOVED_FROM
    | IN_MOVED_TO
    | IN_CREATE
    | IN_DELETE
    | IN_DELETE_SELF
)
EVENT_HEADER = struct.Struct("iIII")
# How long a directory moved away waits for the other half of its move. The
# kernel queues both halves back to back, so only a read that lands between
# them, or a full buffer, splits a pair; the other half follows at once.
MOVE_PAIR_SECONDS = 0.05


def _event_type(mask: int) -> str:
    for bit, name in (
        (IN_CREATE, "create"),
        (IN_MODIFY | IN_CLOSE_WRITE, "write"),
        (IN_DELETE | IN_DELETE_SELF, "remove"),
        (IN_MOVED_FROM | IN_MOVED_TO, "rename"),
        (IN_ATTRIB, "chmod"),
    ):
        if mask & bit:
            return name
    return "other"


class Inotify:
    """A minimal recursive inotify watcher over ctypes.

    A directory keeps its watch when it moves, so the watcher tracks moves:
    a directory moved within the tree has its descendants' paths rewritten,
    one moved out has its watches removed, and one moved in or created is
    watched together with everything already inside it.

    A move away is held for `MOVE_PAIR_SECONDS` in case its arrival in the
    tree comes in a later read; only then does it count as moved out.
    A move out removes the watches the directory had when it left, so a
    new directory made at the old path in the meantime keeps its own. Each
    watch belongs to at most one pending departure, the earliest: a parent
    moving while its child's departure is pending leaves the child's watch
    to the child's departure. A move whose arrival is seen rewrites the
    paths of every watch below the old path, and the old paths of
    departures pending below it, so later moves start from where things are
    now.

    Every directory that arrives in the tree, paired with its departure or
    not, is walked and watched again. Asking the kernel to watch a directory
    it already watches hands back the same watch, so a watch the walk finds
    belongs to the tree again and is left alone when the departure that
    took it settles: a directory that returns under another name, or a
    child that comes back on its own while its parent is still away. The
    walk sees only what is in the tree now, so it never takes back a watch
    that is still outside. A directory arriving inside one that is away is
    not walked; it goes or returns with that one.
    """

    def __init__(
        self,
        root: Path,
        recursive: bool,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        self._add = libc.inotify_add_watch
        self._add.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self._remove = libc.inotify_rm_watch
        self._remove.argtypes = [ctypes.c_int, ctypes.c_int]
        self._fd = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        self._root = root
        self._recursive = recursive
        self._clock = clock
        self._dirs: dict[int, Path] = {}
        # Directories moved away whose arrival is not seen yet: by cookie,
        # their old path, when to give up waiting and the watches they took.
        self._departed: dict[int, tuple[Path, float, list[int]]] = {}
        # Which pending departure each of those watches still belongs to.
        self._departing: dict[int, int] = {}
        self._watch(root)
        if recursive:
            self._watch_below(root)

    def fileno(self) -> int:
        return self._fd

    def watched(self) -> dict[int, Path]:
        """The directories watched now, by watch descriptor."""

        return dict(self._dirs)

    def _watch(self, directory: Path) -> None:
        descriptor = self._add(self._fd, os.fsencode(directory), WATCHED)
        if descriptor < 0:
            error = ctypes.get_errno()
            raise OSError(error, f"cannot watch {directory}: {os.strerror(error)}")
        self._dirs[descriptor] = directory
        # The kernel hands back the watch an inode already has: a directory
        # that left and came back is the tree's again, not its departure's.
        self._departing.pop(descriptor, None)

    def _watch_below(self, top: Path) -> None:
        """Watches every directory below `top`. One that vanishes on the way
        is skipped: its removal is reported anyway."""

        for directory, subdirs, _ in os.walk(top):
            for name in subdirs:
                with contextlib.suppress(OSError):
                    self._watch(Path(directory) / name)

    def _watch_tree(self, top: Path) -> None:
        """Watches `top` and everything below it as they are now. Anything
        inside may predate the watch: a directory moved in arrives full, and
        a new one fills fast."""

        with contextlib.suppress(OSError):
            self._watch(top)
        self._watch_below(top)

    def _below(self, top: Path) -> list[tuple[int, Path]]:
        return [
            (descriptor, path)
            for descriptor, path in self._dirs.items()
            if path == top or top in path.parents
        ]

    def _moved_within(self, old: Path, new: Path) -> None:
        """Rewrites `old` to `new` in every watched path and every pending
        departure's old path at or below it."""

        for descriptor, path in self._below(old):
            self._dirs[descriptor] = new / path.relative_to(old)
        for cookie, (path, deadline, taken) in list(self._departed.items()):
            if path == old or old in path.parents:
                self._departed[cookie] = (new / path.relative_to(old), deadline, taken)

    def _moved_out(self, descriptors: list[int]) -> None:
        for descriptor in descriptors:
            if self._dirs.pop(descriptor, None) is not None:
                self._remove(self._fd, descriptor)

    def _depart(self, cookie: int, path: Path) -> None:
        """Holds the watches at and below `path` for the move `cookie`,
        except those an earlier pending departure holds: they stay its own,
        to remove or keep when it settles."""

        taken = [
            descriptor for descriptor, _ in self._below(path) if descriptor not in self._departing
        ]
        self._departed[cookie] = (path, self._clock() + MOVE_PAIR_SECONDS, taken)
        for descriptor in taken:
            self._departing[descriptor] = cookie

    def _settle(self, cookie: int) -> tuple[Path, list[int]]:
        """Ends the departure `cookie`: its old path and the watches it
        still holds."""

        old, _, taken = self._departed.pop(cookie)
        held = [descriptor for descriptor in taken if self._departing.get(descriptor) == cookie]
        for descriptor in held:
            del self._departing[descriptor]
        return old, held

    def _join(self, cookie: int, descriptors: list[int]) -> None:
        """Gives `descriptors` to the pending departure `cookie`: they moved
        into a directory that is away, so they go or return with it."""

        self._departed[cookie][2].extend(descriptors)
        for descriptor in descriptors:
            self._departing[descriptor] = cookie

    def read_events(self) -> list[dict[str, str]]:
        """The events waiting now, possibly none. Call it again within
        `settle_seconds` even without new events, so a directory moved out
        of the tree stops being watched."""

        try:
            buffer = os.read(self._fd, 64 * 1024)
        except BlockingIOError:
            buffer = b""
        events = self.parse(buffer)
        now = self._clock()
        for cookie, (_, deadline, _) in list(self._departed.items()):
            if deadline <= now:
                _, held = self._settle(cookie)
                self._moved_out(held)
        return events

    def settle_seconds(self) -> float | None:
        """How soon `read_events` must run again to settle a pending move,
        or None when none is pending."""

        if not self._departed:
            return None
        deadline = min(deadline for _, deadline, _ in self._departed.values())
        return max(0.0, deadline - self._clock())

    def parse(self, buffer: bytes) -> list[dict[str, str]]:
        """The events in one read from the inotify descriptor."""

        events = []
        offset = 0
        while offset < len(buffer):
            descriptor, mask, cookie, length = EVENT_HEADER.unpack_from(buffer, offset)
            offset += EVENT_HEADER.size
            raw = buffer[offset : offset + length].rstrip(b"\0")
            offset += length
            directory = self._dirs.get(descriptor)
            if mask & IN_IGNORED or directory is None:
                self._dirs.pop(descriptor, None)
                self._departing.pop(descriptor, None)
                continue
            path = directory / os.fsdecode(raw) if raw else directory
            if self._recursive and mask & IN_ISDIR:
                if mask & IN_MOVED_FROM:
                    self._depart(cookie, path)
                elif mask & IN_MOVED_TO and cookie in self._departed:
                    old, held = self._settle(cookie)
                    self._moved_within(old, path)
                    away = self._departing.get(descriptor)
                    if away is None:
                        self._watch_tree(path)
                    else:
                        self._join(away, held)
                elif mask & (IN_CREATE | IN_MOVED_TO) and descriptor not in self._departing:
                    self._watch_tree(path)
            events.append(
                {
                    "name": path.relative_to(self._root).as_posix(),
                    "type": _event_type(mask),
                }
            )
        return events

    def close(self) -> None:
        os.close(self._fd)


def stream_watch(
    request: dict[str, Any],
    connection: socket.socket,
    send: Callable[[dict[str, Any]], None],
) -> None:
    """Streams events until the client closes the connection. Waiting on the
    connection as well as the watcher ends the stream as soon as the client
    goes, rather than at the next filesystem event."""

    root = Path(_field(request, "path", str))
    if not root.is_dir():
        raise RequestError(f"not a directory: {root}")
    watcher = Inotify(root, bool(request.get("recursive", False)))
    try:
        send({"ok": True})
        poll = select.poll()
        poll.register(watcher, select.POLLIN)
        poll.register(connection, select.POLLIN | select.POLLRDHUP)
        while True:
            settle = watcher.settle_seconds()
            ready = poll.poll(None if settle is None else math.ceil(settle * 1000))
            if any(descriptor == connection.fileno() for descriptor, _ in ready):
                # The client sends nothing after its request, so input here
                # means it closed its side.
                return
            for event in watcher.read_events():
                send(event)
    finally:
        watcher.close()


OPERATIONS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "ping": op_ping,
    "exec": op_exec,
    "spawn": op_spawn,
    "processes": op_processes,
    "signal": op_signal,
    "wait": op_wait,
    "output": op_output,
    "read": op_read,
    "write": op_write,
    "mkdir": op_mkdir,
    "exists": op_exists,
    "list": op_list,
    "rename": op_rename,
    "remove": op_remove,
}


def serve_connection(connection: socket.socket) -> None:
    """Serves the one request a connection carries."""

    with connection, connection.makefile("rb") as reader:

        def send(message: dict[str, Any]) -> None:
            connection.sendall(json.dumps(message, separators=(",", ":")).encode() + b"\n")

        line = reader.readline(MAX_REQUEST + 1)
        if not line:
            return
        try:
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise RequestError("request too large or not one line")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RequestError("request must be a JSON object")
            op = request.get("op")
            if op == "watch":
                stream_watch(request, connection, send)
                return
            handler = OPERATIONS.get(op) if isinstance(op, str) else None
            if handler is None:
                raise RequestError(f"unknown op {op!r}")
            reply = {"ok": True, **handler(request)}
        except (BrokenPipeError, ConnectionResetError):
            return
        except (RequestError, OSError, ValueError) as error:
            reply = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            send(reply)


def listen(address: str) -> socket.socket:
    """`vsock:PORT` inside a VM, or `unix:PATH` to test the service on a host."""

    kind, _, where = address.partition(":")
    if kind == "vsock":
        server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        server.bind((socket.VMADDR_CID_ANY, int(where)))
    elif kind == "unix":
        Path(where).unlink(missing_ok=True)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(where)
    else:
        raise SystemExit(f"listen address must be vsock:PORT or unix:PATH, not {address!r}")
    server.listen(128)
    return server


def serve(server: socket.socket) -> None:
    while True:
        connection, _ = server.accept()
        threading.Thread(
            target=serve_connection, args=(connection,), name="request", daemon=True
        ).start()


def parse_notice(line: bytes) -> tuple[int, dict[str, str]] | None:
    """Splits `restored <nanos> [key=value ...]` into the time and its fields.

    Returns None for anything else, including a line longer than
    MAX_NOTICE. Words without `=` are skipped like unknown fields, so a later
    host can add to the line without older guests refusing it."""

    if len(line) > MAX_NOTICE:
        return None
    words = line.decode("ascii", errors="replace").split()
    if len(words) < 2 or words[0] != "restored" or not words[1].isdigit():
        return None
    fields = {}
    for word in words[2:]:
        key, equals, value = word.partition("=")
        if equals and key:
            fields[key] = value
    return int(words[1]), fields


def reseed(seed: str, device: str = RANDOM_DEVICE) -> bool:
    """Mixes the host's `seed` (hex) into the kernel's input pool and has the
    random number generator reseed from it at once. Returns whether both
    happened."""

    try:
        data = bytes.fromhex(seed)
    except ValueError:
        return False
    if not data:
        return False
    try:
        with open(device, "wb", buffering=0) as pool:
            pool.write(data)
            fcntl.ioctl(pool, RNDRESEEDCRNG)
    except OSError as error:
        print(f"cannot reseed: {error}", file=sys.stderr, flush=True)
        return False
    return True


def _replace(path: Path, text: str) -> None:
    """Writes `text` to `path`, replacing it whole."""

    staged = path.with_name(f".{path.name}.{os.getpid()}")
    staged.write_text(text, encoding="ascii")
    os.replace(staged, path)


def owns_identity(sandbox: str) -> bool:
    """Whether the machine id on this disk was made for `sandbox`."""

    try:
        return IDENTITY.read_text(encoding="ascii").strip() == sandbox
    except OSError:
        return False


def _hostname(sandbox: str, machine_id: str) -> str:
    return sandbox if _HOSTNAME_LABEL.fullmatch(sandbox) else f"sandbox-{machine_id[:12]}"


def renew_identity(sandbox: str, seed: str) -> bool:
    """Gives a guest that has just learned it is `sandbox` its own machine
    id and hostname, in place of its template's: a clone, or one booted
    from a disk cloned from a template. The machine id comes from the seed
    and the id, so a retried notice writes the same one; the record of whom
    it was made for is written last. Returns whether all were set."""

    machine_id = hashlib.sha256(f"{seed}:{sandbox}".encode()).hexdigest()[:32]
    try:
        _replace(MACHINE_ID, machine_id + "\n")
        HOSTNAME.write_text(_hostname(sandbox, machine_id) + "\n", encoding="ascii")
        _replace(IDENTITY, sandbox + "\n")
    except OSError as error:
        print(f"cannot renew the machine identity: {error}", file=sys.stderr, flush=True)
        return False
    return True


def take_identity(sandbox: str | None) -> None:
    """At startup: a guest whose disk's machine id was made for another
    sandbox (its template's, or the base image's) makes its own; one whose
    was made for it keeps it and only sets the hostname, which a boot does
    not keep."""

    if sandbox is None:
        return
    if not owns_identity(sandbox):
        renew_identity(sandbox, os.urandom(32).hex())
        return
    try:
        machine_id = MACHINE_ID.read_text(encoding="ascii").strip()
        HOSTNAME.write_text(_hostname(sandbox, machine_id) + "\n", encoding="ascii")
    except OSError as error:
        print(f"cannot set the hostname: {error}", file=sys.stderr, flush=True)


def notice_order(fields: dict[str, str]) -> tuple[int, int] | None:
    """A notice's `order=<generation>.<revision>`, or None without a valid
    one."""

    generation, dot, revision = fields.get("order", "").partition(".")
    if not (dot and generation.isdigit() and revision.isdigit()):
        return None
    return int(generation), int(revision)


class Notices:
    """Applies restore notices one at a time, each whole, in the host's
    order (see the module documentation): one ordered below the latest
    applied (an abandoned attempt that arrived or finished late) is
    obsolete and refused, so it can never take back a newer identity. The
    attempts of one notice share its order, so a retry is applied again."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: tuple[int, int] | None = None

    def apply(self, order: tuple[int, int] | None, act: Callable[[], bytes | None]) -> bytes | None:
        """Runs `act` unless a notice ordered after `order` was applied;
        returns its answer, or None for an obsolete notice. A notice
        without an order is not ordered."""

        with self._lock:
            if order is not None:
                if self._latest is not None and order < self._latest:
                    return None
                self._latest = order
            return act()


NOTICES = Notices()


def serve_notice(connection: socket.socket, *, set_clock: bool) -> None:
    """Acts on one restore notice: sets the clock, counts the restore, takes
    the sandbox id (renewing the machine identity unless it was made for
    that sandbox), applies the seed and answers `ok seeded`, or `ok` when
    there was no seed or it or the identity could not be applied. An
    obsolete notice (see `Notices`) or anything else closes the connection
    unanswered."""

    with connection, connection.makefile("rb") as reader:
        line = reader.readline(MAX_NOTICE + 1)
        if line == b"activity\n":
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                connection.sendall(f"commands {awake_commands()}\n".encode())
            return
        notice = parse_notice(line)
        if notice is None:
            print(f"ignored restore notice {line[:80]!r}", file=sys.stderr, flush=True)
            return
        nanos, fields = notice
        answer = NOTICES.apply(
            notice_order(fields), lambda: _act_on_notice(nanos, fields, set_clock=set_clock)
        )
        if answer is None:
            print(f"ignored restore notice {line[:80]!r}", file=sys.stderr, flush=True)
            return
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            connection.sendall(answer)


def _act_on_notice(nanos: int, fields: dict[str, str], *, set_clock: bool) -> bytes | None:
    """The whole of one notice's change; returns the answer, or None to
    leave it unanswered."""

    if set_clock:
        try:
            time.clock_settime_ns(time.CLOCK_REALTIME, nanos)
        except OSError as error:
            # A guest that cannot set its clock still counts the restore.
            print(f"cannot set the clock: {error}", file=sys.stderr, flush=True)
    sandbox = fields.get("sandbox") or None
    if (
        sandbox is not None
        and (sandbox != RESTORES.sandbox() or not owns_identity(sandbox))
        and not renew_identity(sandbox, fields.get("seed", ""))
    ):
        # The id is not taken, so a retry renews again; meanwhile the host
        # must not use this guest.
        return b"ok\n"
    try:
        RESTORES.record(sandbox)
    except OSError as error:
        # Unanswered, the host tries again: an id the guest could not keep
        # is not taken.
        print(f"cannot keep the sandbox id: {error}", file=sys.stderr, flush=True)
        return None
    seeded = "seed" in fields and reseed(fields["seed"])
    return b"ok seeded\n" if seeded else b"ok\n"


def serve_notices(server: socket.socket, *, set_clock: bool) -> None:
    while True:
        connection, _ = server.accept()
        threading.Thread(
            target=serve_notice,
            args=(connection,),
            kwargs={"set_clock": set_clock},
            name="notice",
            daemon=True,
        ).start()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--listen", default="vsock:53")
    parser.add_argument(
        "--notice",
        default=None,
        help="address for the host agent's restore notices, such as vsock:54",
    )
    parser.add_argument(
        "--keep-clock",
        action="store_true",
        help="count restore notices without setting the clock (to test on a host)",
    )
    args = parser.parse_args()
    _outlast_user_programs()
    take_identity(RESTORES.sandbox())
    if args.notice is not None:
        notices = listen(args.notice)
        threading.Thread(
            target=serve_notices,
            args=(notices,),
            kwargs={"set_clock": not args.keep_clock},
            name="notices",
            daemon=True,
        ).start()
        print(f"smoke guest taking restore notices on {args.notice}", file=sys.stderr, flush=True)
    print(f"smoke guest serving on {args.listen}", file=sys.stderr, flush=True)
    serve(listen(args.listen))


if __name__ == "__main__":
    main()
