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
(`restored <unix time in nanoseconds>`, answered with `ok`): it sets the
clock and counts restores, which `ping` reports, so a scenario can tell how
many times its own sandbox was restored from a memory image.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import ctypes.util
import itertools
import json
import math
import os
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
MAX_NOTICE = 64
OUTPUT_DIR = Path(os.environ.get("SMOKE_GUEST_STATE", "/run/smoke-guest"))
_OUTPUT_NAMES = itertools.count()


class RequestError(Exception):
    """The request cannot be served; the message goes back to the client."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def _field(request: dict[str, Any], name: str, kind: type | tuple[type, ...]) -> Any:
    value = request.get(name)
    # JSON true and false are never numbers here.
    if isinstance(value, bool) or not isinstance(value, kind):
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

    def __init__(self, command: str, env: dict[str, str], cwd: str | None) -> None:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self.command = command
        name = f"{os.getpid()}-{next(_OUTPUT_NAMES)}"
        self._stdout = (OUTPUT_DIR / f"{name}.out").open("w+b")
        self._stderr = (OUTPUT_DIR / f"{name}.err").open("w+b")
        self.popen = subprocess.Popen(
            ["/bin/bash", "-c", command],
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

    def start(self, command: str, env: dict[str, str], cwd: str | None) -> Process:
        process = Process(command, env, cwd)
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


class Restores:
    """How many restore notices this service has acknowledged."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._count = 0

    def record(self) -> None:
        with self._lock:
            self._count += 1

    def count(self) -> int:
        with self._lock:
            return self._count


RESTORES = Restores()


def op_ping(_request: dict[str, Any]) -> dict[str, Any]:
    return {"pid": os.getpid(), "restores": RESTORES.count()}


def op_exec(request: dict[str, Any]) -> dict[str, Any]:
    command = _field(request, "command", str)
    timeout = _optional(request, "timeout", (int, float), None)
    process = subprocess.Popen(
        ["/bin/bash", "-c", command],
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
        # their old path and when to give up waiting.
        self._departed: dict[int, tuple[Path, float]] = {}
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

    def _watch_below(self, top: Path) -> None:
        """Watches every directory below `top`. One that vanishes on the way
        is skipped: its removal is reported anyway."""

        for directory, subdirs, _ in os.walk(top):
            for name in subdirs:
                with contextlib.suppress(OSError):
                    self._watch(Path(directory) / name)

    def _below(self, top: Path) -> list[tuple[int, Path]]:
        return [
            (descriptor, path)
            for descriptor, path in self._dirs.items()
            if path == top or top in path.parents
        ]

    def _moved_within(self, old: Path, new: Path) -> None:
        for descriptor, path in self._below(old):
            self._dirs[descriptor] = new / path.relative_to(old)

    def _moved_out(self, top: Path) -> None:
        for descriptor, _ in self._below(top):
            del self._dirs[descriptor]
            self._remove(self._fd, descriptor)

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
        for cookie, (path, deadline) in list(self._departed.items()):
            if deadline <= now:
                del self._departed[cookie]
                self._moved_out(path)
        return events

    def settle_seconds(self) -> float | None:
        """How soon `read_events` must run again to settle a pending move,
        or None when none is pending."""

        if not self._departed:
            return None
        deadline = min(deadline for _, deadline in self._departed.values())
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
                continue
            path = directory / os.fsdecode(raw) if raw else directory
            if self._recursive and mask & IN_ISDIR:
                if mask & IN_MOVED_FROM:
                    self._departed[cookie] = (path, self._clock() + MOVE_PAIR_SECONDS)
                elif mask & IN_MOVED_TO and cookie in self._departed:
                    self._moved_within(self._departed.pop(cookie)[0], path)
                elif mask & (IN_CREATE | IN_MOVED_TO):
                    # Anything inside may predate the watch: a directory
                    # moved in arrives full, and a new one fills fast.
                    with contextlib.suppress(OSError):
                        self._watch(path)
                    self._watch_below(path)
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


def serve_notice(connection: socket.socket, *, set_clock: bool) -> None:
    """Acts on one restore notice: sets the clock, counts the restore and
    answers `ok`. Anything else closes the connection unanswered."""

    with connection, connection.makefile("rb") as reader:
        line = reader.readline(MAX_NOTICE + 1)
        word, _, nanos = line.decode("ascii", errors="replace").strip().partition(" ")
        if word != "restored" or not nanos.isdigit():
            print(f"ignored restore notice {line[:MAX_NOTICE]!r}", file=sys.stderr, flush=True)
            return
        if set_clock:
            try:
                time.clock_settime_ns(time.CLOCK_REALTIME, int(nanos))
            except OSError as error:
                # A guest that cannot set its clock still counts the restore.
                print(f"cannot set the clock: {error}", file=sys.stderr, flush=True)
        RESTORES.record()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            connection.sendall(b"ok\n")


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
