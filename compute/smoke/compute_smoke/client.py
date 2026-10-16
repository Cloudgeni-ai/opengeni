"""Clients for the host agent's socket and the reference guest service, and
an E2B-style sandbox handle built on both.

The host agent answers one JSON request per connection on a Unix socket. Its
`connect` request wakes the sandbox and turns the connection into a byte
stream to a guest vsock port, where the reference guest service
(`guest/smoke_guest.py`) answers one JSON request per connection. Every
sandbox operation the scenarios use is one of those two round trips.

Waking is implicit, as in Opengeni: any access to a sleeping sandbox wakes it.
E2B's sandbox timeout maps to the sandbox's idle time before it pauses, and
refreshing or setting the timeout maps to a named hold with an expiry.
"""

from __future__ import annotations

import base64
import contextlib
import json
import socket
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import IO, Any

MAX_LINE = 96 << 20
DEFAULT_TIMEOUT = 120.0
TIMEOUT_HOLD = "e2b-timeout"

# Levels from awake to most deeply asleep, as the host agent names them.
LEVELS = ("running", "paused", "compressed", "saved", "archived", "remote")


class HostAgentError(RuntimeError):
    """The host agent refused or failed a request."""


class SandboxUnavailable(RuntimeError):
    """The sandbox or its guest service could not be reached."""


class GuestError(RuntimeError):
    """The guest service reported that a request failed."""


class Stream:
    """One connection, read line by line, keeping bytes that follow a line."""

    def __init__(self, connection: socket.socket) -> None:
        self._connection = connection
        self._buffer = bytearray()

    def settimeout(self, timeout: float | None) -> None:
        self._connection.settimeout(timeout)

    def send_json(self, message: Mapping[str, Any]) -> None:
        data = json.dumps(message, separators=(",", ":")).encode() + b"\n"
        self._connection.sendall(data)

    def read_json(self) -> dict[str, Any]:
        line = self.read_line()
        if line is None:
            raise SandboxUnavailable("connection closed before a reply")
        message = json.loads(line)
        if not isinstance(message, dict):
            raise SandboxUnavailable(f"reply is not a JSON object: {line[:200]!r}")
        return message

    def read_line(self) -> bytes | None:
        """The next line without its newline, or None at a clean end."""

        start = 0
        while True:
            end = self._buffer.find(b"\n", start)
            if end >= 0:
                line = bytes(self._buffer[:end])
                del self._buffer[: end + 1]
                return line
            if len(self._buffer) > MAX_LINE:
                raise SandboxUnavailable("reply line too long")
            start = len(self._buffer)
            chunk = self._connection.recv(1 << 20)
            if not chunk:
                if self._buffer:
                    raise SandboxUnavailable("connection closed mid-line")
                return None
            self._buffer += chunk

    def close(self) -> None:
        self._connection.close()

    def shutdown(self) -> None:
        """Ends the connection in both directions, waking a blocked reader."""

        with contextlib.suppress(OSError):
            self._connection.shutdown(socket.SHUT_RDWR)


class HostAgent:
    """The host agent's local API."""

    def __init__(self, socket_path: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.socket_path = socket_path
        self.timeout = timeout

    def _open(self, timeout: float | None) -> Stream:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(self.timeout if timeout is None else timeout)
        try:
            connection.connect(self.socket_path)
        except OSError as error:
            connection.close()
            raise SandboxUnavailable(
                f"host agent at {self.socket_path} unreachable: {error}"
            ) from error
        return Stream(connection)

    def request(
        self, message: Mapping[str, Any], *, timeout: float | None = None
    ) -> dict[str, Any]:
        stream = self._open(timeout)
        try:
            stream.send_json(message)
            reply = stream.read_json()
        finally:
            stream.close()
        if reply.get("result") == "error":
            raise HostAgentError(str(reply.get("message", reply)))
        return reply

    def create(self, sandbox_id: str, config: Mapping[str, Any]) -> None:
        self.request({"op": "create", "id": sandbox_id, "config": dict(config)})

    def remove(self, sandbox_id: str) -> None:
        self.request({"op": "remove", "id": sandbox_id})

    def wake(self, sandbox_id: str, *, timeout: float | None = None) -> dict[str, Any]:
        return self.request({"op": "wake", "id": sandbox_id}, timeout=timeout)

    def touch(self, sandbox_id: str) -> None:
        self.request({"op": "touch", "id": sandbox_id})

    def sleep(self, sandbox_id: str, level: str) -> None:
        if level not in LEVELS:
            raise ValueError(f"unknown level {level!r}")
        self.request({"op": "sleep", "id": sandbox_id, "level": level})

    def hold(self, sandbox_id: str, name: str, *, ttl_seconds: float | None) -> None:
        message: dict[str, Any] = {"op": "hold", "id": sandbox_id, "hold": name}
        if ttl_seconds is not None:
            message["ttl_ms"] = max(1, round(ttl_seconds * 1000))
        self.request(message)

    def release(self, sandbox_id: str, name: str) -> None:
        self.request({"op": "release", "id": sandbox_id, "hold": name})

    def status(self) -> dict[str, Any]:
        return self.request({"op": "status"})

    def sandbox(self, sandbox_id: str) -> dict[str, Any] | None:
        """The host agent's view of one sandbox, or None if it has none."""

        wanted = sandbox_id.replace("-", "").lower()
        for entry in self.status().get("sandboxes", ()):
            if str(entry.get("id", "")).replace("-", "").lower() == wanted:
                return entry
        return None

    def connect(self, sandbox_id: str, port: int, *, timeout: float | None) -> Stream:
        """Wakes the sandbox and returns a byte stream to `port` inside it."""

        stream = self._open(timeout)
        try:
            stream.send_json({"op": "connect", "id": sandbox_id, "port": port})
            reply = stream.read_json()
        except BaseException:
            stream.close()
            raise
        if reply.get("result") != "connected":
            stream.close()
            raise SandboxUnavailable(
                f"cannot reach port {port} of {sandbox_id}: {reply.get('message', reply)}"
            )
        return stream


class Guest:
    """The reference guest service inside one sandbox."""

    def __init__(self, host: HostAgent, sandbox_id: str, port: int) -> None:
        self.host = host
        self.sandbox_id = sandbox_id
        self.port = port

    def open(
        self, op: str, *, io_timeout: float | None, **fields: Any
    ) -> tuple[Stream, dict[str, Any]]:
        """Sends one request; returns the stream and the successful reply.

        `io_timeout` bounds each socket operation, including waking the
        sandbox; `fields` go to the guest, which has its own `timeout`."""

        stream = self.host.connect(self.sandbox_id, self.port, timeout=io_timeout)
        try:
            stream.send_json({"op": op, **fields})
            reply = stream.read_json()
        except BaseException:
            stream.close()
            raise
        if not reply.get("ok"):
            stream.close()
            raise GuestError(str(reply.get("error", reply)))
        return stream, reply

    def call(self, op: str, *, io_timeout: float | None = None, **fields: Any) -> dict[str, Any]:
        stream, reply = self.open(op, io_timeout=io_timeout, **fields)
        stream.close()
        return reply


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: object) -> bytes:
    if not isinstance(text, str):
        raise GuestError(f"expected base64 text, got {type(text).__name__}")
    return base64.b64decode(text.encode("ascii"), validate=True)


def _text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str


def _command_result(reply: Mapping[str, Any]) -> CommandResult:
    return CommandResult(
        exit_code=int(reply["exit_code"]),
        stdout=_text(_unb64(reply["stdout"])),
        stderr=_text(_unb64(reply["stderr"])),
    )


class SandboxState(str, Enum):
    """The public state: running, or paused at any depth of sleep."""

    RUNNING = "running"
    PAUSED = "paused"


@dataclass(frozen=True)
class SandboxInfo:
    sandbox_id: str
    state: SandboxState
    level: str
    durability: str
    memory_saved: bool
    step: str | None
    holds: int
    broken: bool
    # VM processes the host agent started for the sandbox, boots and
    # restores alike, since the agent started.
    launches: int = 0

    @classmethod
    def from_status(cls, sandbox_id: str, entry: Mapping[str, Any]) -> SandboxInfo:
        level = str(entry["level"])
        return cls(
            sandbox_id=sandbox_id,
            state=SandboxState.RUNNING if level == "running" else SandboxState.PAUSED,
            level=level,
            durability=str(entry.get("durability")),
            memory_saved=bool(entry.get("memory_saved")),
            step=entry.get("step"),
            holds=int(entry.get("holds", 0)),
            broken=bool(entry.get("broken")),
            launches=int(entry.get("launches", 0)),
        )


@dataclass(frozen=True)
class EntryInfo:
    name: str
    path: str
    type: str


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    command: str
    running: bool = True

    @property
    def process_id(self) -> str:
        return str(self.pid)


class ProcessHandle:
    """A background command; dropping the handle leaves the command running."""

    def __init__(self, guest: Guest, pid: int, *, timeout: float | None) -> None:
        self._guest = guest
        self.pid = pid
        self._timeout = timeout

    @property
    def process_id(self) -> str:
        return str(self.pid)

    def disconnect(self) -> None:
        """Stops following the command. Each request is its own connection,
        so nothing stays open."""

    def wait(self) -> CommandResult:
        reply = self._guest.call(
            "wait",
            io_timeout=None if self._timeout is None else self._timeout + DEFAULT_TIMEOUT,
            pid=self.pid,
            timeout=self._timeout,
        )
        return _command_result(reply)


class Files:
    """E2B-style file access inside a sandbox."""

    def __init__(self, guest: Guest) -> None:
        self._guest = guest

    def read(self, path: str, *, request_timeout: float | None = None) -> str:
        return _text(self.read_bytes(path, request_timeout=request_timeout))

    def read_bytes(self, path: str, *, request_timeout: float | None = None) -> bytes:
        reply = self._guest.call("read", io_timeout=request_timeout, path=path)
        return _unb64(reply["data"])

    def write(self, path: str, data: str | bytes | IO[bytes]) -> EntryInfo:
        if isinstance(data, str):
            content = data.encode()
        elif isinstance(data, bytes):
            content = data
        else:
            content = data.read()
        self._guest.call("write", path=path, data=_b64(content))
        return EntryInfo(name=path.rsplit("/", 1)[-1], path=path, type="file")

    def exists(self, path: str) -> bool:
        return bool(self._guest.call("exists", path=path)["exists"])

    def make_dir(self, path: str) -> bool:
        return bool(self._guest.call("mkdir", path=path)["created"])

    def remove(self, path: str) -> None:
        self._guest.call("remove", path=path)

    def rename(self, old_path: str, new_path: str) -> EntryInfo:
        self._guest.call("rename", source=old_path, target=new_path)
        return EntryInfo(name=new_path.rsplit("/", 1)[-1], path=new_path, type="file")

    def list(self, path: str) -> list[EntryInfo]:
        entries = self._guest.call("list", path=path)["entries"]
        return [EntryInfo(e["name"], e["path"], e["type"]) for e in entries]


@dataclass(frozen=True)
class FilesystemEvent:
    name: str
    type: str


class WatchHandle:
    """A live directory watcher; events are collected on a thread."""

    def __init__(self, stream: Stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._events: list[FilesystemEvent] = []
        self._error: BaseException | None = None
        self._stopped = threading.Event()
        stream.settimeout(None)
        self._thread = threading.Thread(target=self._read, name="watch", daemon=True)
        self._thread.start()

    def _read(self) -> None:
        try:
            while (line := self._stream.read_line()) is not None:
                event = json.loads(line)
                with self._lock:
                    self._events.append(FilesystemEvent(event["name"], event["type"]))
        except BaseException as error:  # noqa: BLE001 - surfaced by get_new_events
            if not self._stopped.is_set():
                self._error = error

    def get_new_events(self) -> list[FilesystemEvent]:
        with self._lock:
            events, self._events = self._events, []
        if not events and self._error is not None:
            raise SandboxUnavailable(f"watcher stopped: {self._error}")
        return events

    def stop(self) -> None:
        self._stopped.set()
        self._stream.shutdown()
        self._stream.close()
        self._thread.join(5)


class Sandbox:
    """One sandbox, addressed by id through the host agent."""

    def __init__(
        self,
        host: HostAgent,
        sandbox_id: str,
        *,
        guest_port: int,
        timeout: int,
    ) -> None:
        self.host = host
        self.sandbox_id = sandbox_id
        self.timeout = timeout
        self._guest = Guest(host, sandbox_id, guest_port)
        self.files = Files(self._guest)

    def run(
        self,
        command: str,
        *,
        timeout: float = 60,
        envs: Mapping[str, str] | None = None,
        cwd: str | None = None,
    ) -> CommandResult:
        fields: dict[str, Any] = {"command": command, "timeout": timeout}
        if envs is not None:
            fields["env"] = dict(envs)
        if cwd is not None:
            fields["cwd"] = cwd
        # The connection waits for the wake and the command together.
        reply = self._guest.call("exec", io_timeout=timeout + DEFAULT_TIMEOUT, **fields)
        return _command_result(reply)

    def ping(self, *, timeout: float = DEFAULT_TIMEOUT) -> int:
        """The guest service's process id; changes only after a fresh boot."""

        return int(self._guest.call("ping", io_timeout=timeout)["pid"])

    def restore_count(self, *, timeout: float = DEFAULT_TIMEOUT) -> int:
        """How many restore notices the guest service has acknowledged since
        it started. Every restore from a memory image adds at least one; a
        notice the host repeats after losing the answer adds another. Waking
        the sandbox to ask does not restore it."""

        return int(self._guest.call("ping", io_timeout=timeout)["restores"])

    def start_background(self, command: str, *, timeout: float = 60) -> ProcessHandle:
        pid = int(self._guest.call("spawn", command=command)["pid"])
        return ProcessHandle(self._guest, pid, timeout=timeout)

    def connect_process(self, pid: int, *, timeout: float = 60) -> ProcessHandle:
        """Follows a background command again, running or ended, as long as
        no one has collected its result yet."""

        if not any(process.pid == pid for process in self.list_processes(include_ended=True)):
            raise SandboxUnavailable(f"process {pid} is unknown or its result was collected")
        return ProcessHandle(self._guest, pid, timeout=timeout)

    def list_processes(self, *, include_ended: bool = False) -> tuple[ProcessInfo, ...]:
        """Running background commands; with `include_ended`, also those that
        ended but whose result is not collected yet."""

        processes = self._guest.call("processes", all=include_ended)["processes"]
        return tuple(
            ProcessInfo(int(p["pid"]), str(p["command"]), bool(p.get("running", True)))
            for p in processes
        )

    def get_process(self, process_id: str) -> ProcessInfo | None:
        return next((p for p in self.list_processes() if p.process_id == process_id), None)

    def signal_process(self, process_id: str, signal_number: int) -> bool:
        reply = self._guest.call("signal", pid=int(process_id), signal=signal_number)
        return bool(reply["delivered"])

    def watch_dir(self, path: str, *, recursive: bool = False) -> WatchHandle:
        stream, _ = self._guest.open(
            "watch", io_timeout=DEFAULT_TIMEOUT, path=path, recursive=recursive
        )
        return WatchHandle(stream)

    def try_get_info(self) -> SandboxInfo | None:
        entry = self.host.sandbox(self.sandbox_id)
        return None if entry is None else SandboxInfo.from_status(self.sandbox_id, entry)

    def get_info(self) -> SandboxInfo:
        info = self.try_get_info()
        if info is None:
            raise SandboxUnavailable(f"sandbox {self.sandbox_id} does not exist")
        return info

    def connect(self, *, timeout: float | None = None) -> str | None:
        """Wakes the sandbox and returns once the host agent reports it
        woken, with the step that was under way when the wake arrived."""

        reply = self.host.wake(self.sandbox_id, timeout=timeout)
        if reply.get("result") != "woken":
            raise SandboxUnavailable(f"waking {self.sandbox_id} answered {reply!r}")
        during = reply.get("during")
        return None if during is None else str(during)

    def set_timeout(self, seconds: float) -> None:
        """Keeps the sandbox awake for `seconds`; afterwards it pauses once
        idle for its usual idle time. Waking it if it sleeps, like any hold."""

        self.host.hold(self.sandbox_id, TIMEOUT_HOLD, ttl_seconds=seconds)

    def refresh(self) -> None:
        """Restarts the timeout from now."""

        self.set_timeout(self.timeout)

    def sleep(self, level: str) -> None:
        """Asks the host to put the sandbox at least as deep as `level`."""

        self.host.sleep(self.sandbox_id, level)

    def pause(self) -> None:
        self.sleep("paused")

    def kill(self) -> None:
        self.host.remove(self.sandbox_id)


def wait_for_level(
    sandbox: Sandbox,
    levels: Iterable[str],
    *,
    timeout: float,
    interval: float = 0.1,
) -> SandboxInfo | None:
    """Polls until the sandbox is at one of `levels` with no step running,
    returning the last observation either way."""

    wanted = frozenset(levels)
    deadline = time.monotonic() + timeout
    while True:
        info = sandbox.try_get_info()
        if info is not None and info.level in wanted and info.step is None:
            return info
        if time.monotonic() >= deadline:
            return info
        time.sleep(interval)
