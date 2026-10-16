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
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import ctypes.util
import itertools
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, BinaryIO

MAX_REQUEST = 64 << 20
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

    def forget(self, pid: int) -> None:
        with self._lock:
            process = self._by_pid.pop(pid, None)
        if process is not None:
            process.discard()


PROCESSES = Processes()


def op_ping(_request: dict[str, Any]) -> dict[str, Any]:
    return {"pid": os.getpid()}


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


def op_processes(_request: dict[str, Any]) -> dict[str, Any]:
    return {
        "processes": [
            {"pid": process.pid, "command": process.command} for process in PROCESSES.running()
        ]
    }


def op_signal(request: dict[str, Any]) -> dict[str, Any]:
    pid = _field(request, "pid", int)
    number = _field(request, "signal", int)
    process = PROCESSES.get(pid)
    if process.exited.is_set():
        return {"delivered": False}
    try:
        os.kill(pid, number)
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
    """A minimal recursive inotify watcher over ctypes."""

    def __init__(self, root: Path, recursive: bool) -> None:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        self._add = libc.inotify_add_watch
        self._add.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self._fd = libc.inotify_init1(os.O_CLOEXEC)
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        self._root = root
        self._recursive = recursive
        self._dirs: dict[int, Path] = {}
        self._watch(root)
        if recursive:
            for directory, subdirs, _ in os.walk(root):
                for name in subdirs:
                    self._watch(Path(directory) / name)

    def _watch(self, directory: Path) -> None:
        descriptor = self._add(self._fd, os.fsencode(directory), WATCHED)
        if descriptor < 0:
            error = ctypes.get_errno()
            raise OSError(error, f"cannot watch {directory}: {os.strerror(error)}")
        self._dirs[descriptor] = directory

    def events(self) -> Iterator[dict[str, str]]:
        while True:
            buffer = os.read(self._fd, 64 * 1024)
            offset = 0
            while offset < len(buffer):
                descriptor, mask, _cookie, length = EVENT_HEADER.unpack_from(buffer, offset)
                offset += EVENT_HEADER.size
                raw = buffer[offset : offset + length].rstrip(b"\0")
                offset += length
                directory = self._dirs.get(descriptor)
                if mask & IN_IGNORED or directory is None:
                    self._dirs.pop(descriptor, None)
                    continue
                path = directory / os.fsdecode(raw) if raw else directory
                if self._recursive and mask & IN_ISDIR and mask & (IN_CREATE | IN_MOVED_TO):
                    with contextlib.suppress(OSError):
                        self._watch(path)
                yield {
                    "name": path.relative_to(self._root).as_posix(),
                    "type": _event_type(mask),
                }

    def close(self) -> None:
        os.close(self._fd)


def stream_watch(request: dict[str, Any], send: Callable[[dict[str, Any]], None]) -> None:
    root = Path(_field(request, "path", str))
    if not root.is_dir():
        raise RequestError(f"not a directory: {root}")
    watcher = Inotify(root, bool(request.get("recursive", False)))
    try:
        send({"ok": True})
        for event in watcher.events():
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
                stream_watch(request, send)
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--listen", default="vsock:53")
    args = parser.parse_args()
    print(f"smoke guest serving on {args.listen}", file=sys.stderr, flush=True)
    serve(listen(args.listen))


if __name__ == "__main__":
    main()
