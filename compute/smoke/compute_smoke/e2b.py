"""The `ecw.*` scenarios against an E2B-compatible front door.

One adapter: the same sandbox handle the scenarios use with the host agent
(`client.Sandbox`), made of E2B's two surfaces instead. Lifecycle goes to
the REST API (`X-API-Key`), and commands and files go to envd in the guest
(its Connect RPC protocol and `/files`), reached by `<port>-<id>.<domain>`
through the front door. The host agent's socket is only read, to observe
how deeply a sandbox sleeps without touching it, as the scenarios do.

E2B's terms map onto the scenarios' as E2B defines them: a sandbox's
timeout is its deadline, after which it pauses (`autoPause`) and resumes on
traffic (`autoResume`); setting or refreshing the timeout moves the
deadline, resuming a paused sandbox; a pause saves it to disk. The public
state is E2B's, `running` or `paused`; a sandbox E2B calls running may sleep
on its host while unused and wakes when used.

Environment:
  E2B_API_URL, E2B_API_KEY, E2B_DOMAIN   the front door, as for the E2B SDK
  COMPUTE_SMOKE_E2B_ADDRESS   connect here instead of resolving the names
  COMPUTE_SMOKE_E2B_TEMPLATE  the template sandboxes start from (base)
  SSL_CERT_FILE               trust this authority for the front door
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse
import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import IO, Any

from compute_smoke.client import (
    CommandResult,
    EntryInfo,
    FilesystemEvent,
    HostAgent,
    ProcessInfo,
    SandboxInfo,
    SandboxState,
    SandboxUnavailable,
)
from compute_smoke.config import SandboxConfig
from compute_smoke.runtime import ScenarioContext, SmokeConfigurationError

ENVD_PORT = 49983
DEFAULT_TIMEOUT = 120.0
READY_TIMEOUT_SECONDS = 120.0
# Connect's end-of-stream flag on an envelope.
END_STREAM = 0x02
SIGNALS = {9: "SIGNAL_SIGKILL", 15: "SIGNAL_SIGTERM"}
ENTRY_TYPES = {"FILE_TYPE_DIRECTORY": "dir", "FILE_TYPE_FILE": "file"}


class FrontDoorError(RuntimeError):
    """An answer other than success, with its status and E2B's message."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status


class EnvdError(RuntimeError):
    """A Connect error from envd, with its code such as `not_found`."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class _Connection(http.client.HTTPSConnection):
    """HTTPS to a name, connecting to a fixed address when one is given."""

    def __init__(self, host: str, *, address: str | None, **kwargs: Any) -> None:
        super().__init__(host, **kwargs)
        self._address = address

    def connect(self) -> None:
        if self._address is None:
            super().connect()
            return
        raw = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


class FrontDoor:
    """The front door's REST API and its sandbox traffic."""

    def __init__(self, api_url: str, key: str, domain: str, address: str | None) -> None:
        parsed = urllib.parse.urlsplit(api_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise SmokeConfigurationError("E2B_API_URL must be an https URL")
        self.api_host = parsed.hostname
        self.port = parsed.port or 443
        self.key = key
        self.domain = domain
        self.address = address
        self.context = ssl.create_default_context()

    @classmethod
    def from_environment(cls) -> FrontDoor:
        try:
            return cls(
                os.environ["E2B_API_URL"],
                os.environ["E2B_API_KEY"],
                os.environ["E2B_DOMAIN"],
                os.environ.get("COMPUTE_SMOKE_E2B_ADDRESS") or None,
            )
        except KeyError as error:
            raise SmokeConfigurationError(f"the e2b target needs {error.args[0]}") from error

    def connection(self, host: str, timeout: float | None) -> _Connection:
        return _Connection(
            host, address=self.address, port=self.port, timeout=timeout, context=self.context
        )

    def rest(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> Any:
        connection = self.connection(self.api_host, DEFAULT_TIMEOUT)
        try:
            data = None if body is None else json.dumps(body).encode()
            headers = {"X-API-Key": self.key}
            if data is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            text = response.read()
        finally:
            connection.close()
        if response.status >= 300:
            try:
                message = json.loads(text).get("message", "")
            except ValueError:
                message = text.decode(errors="replace")
            raise FrontDoorError(response.status, message)
        return json.loads(text) if text else None


def _envelope(message: Mapping[str, Any]) -> bytes:
    data = json.dumps(message).encode()
    return struct.pack(">BI", 0, len(data)) + data


def _read_exact(response: http.client.HTTPResponse, length: int) -> bytes | None:
    data = b""
    while len(data) < length:
        chunk = response.read(length - len(data))
        if not chunk:
            return data if data else None
        data += chunk
    return data


class _Stream:
    """One server-streaming Connect call to envd: its messages in order."""

    def __init__(self, connection: _Connection, response: http.client.HTTPResponse) -> None:
        self._connection = connection
        self._response = response

    def messages(self) -> Iterator[dict[str, Any]]:
        while (head := _read_exact(self._response, 5)) is not None:
            flags, length = struct.unpack(">BI", head)
            message = json.loads(_read_exact(self._response, length) or b"{}")
            if flags & END_STREAM:
                if error := message.get("error"):
                    raise EnvdError(error.get("code", "unknown"), error.get("message", ""))
                return
            yield message

    def close(self) -> None:
        with _quiet():
            self._connection.sock.shutdown(socket.SHUT_RDWR)
        self._connection.close()


class _quiet:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> bool:
        return exc[0] is not None and issubclass(exc[0], OSError)  # type: ignore[arg-type]


class Envd:
    """E2B's daemon in one sandbox, reached through the front door."""

    def __init__(self, door: FrontDoor, sandbox_id: str, token: str | None) -> None:
        self._door = door
        self.host = f"{ENVD_PORT}-{sandbox_id}.{door.domain}"
        self.token = token

    def _headers(self, content_type: str | None) -> dict[str, str]:
        headers = {"Authorization": "Basic " + base64.b64encode(b"user:").decode()}
        if content_type is not None:
            headers["Content-Type"] = content_type
            headers["Connect-Protocol-Version"] = "1"
        if self.token is not None:
            headers["X-Access-Token"] = self.token
        return headers

    def unary(self, method: str, body: Mapping[str, Any]) -> dict[str, Any]:
        connection = self._door.connection(self.host, DEFAULT_TIMEOUT)
        try:
            connection.request(
                "POST", f"/{method}", json.dumps(body).encode(), self._headers("application/json")
            )
            response = connection.getresponse()
            text = response.read()
        finally:
            connection.close()
        answer = json.loads(text) if text else {}
        if response.status != 200:
            raise EnvdError(answer.get("code", str(response.status)), answer.get("message", ""))
        return answer

    def stream(self, method: str, body: Mapping[str, Any], timeout: float | None) -> _Stream:
        connection = self._door.connection(self.host, timeout)
        connection.request(
            "POST", f"/{method}", _envelope(body), self._headers("application/connect+json")
        )
        response = connection.getresponse()
        if response.status != 200:
            text = response.read()
            connection.close()
            answer = json.loads(text) if text else {}
            raise EnvdError(answer.get("code", str(response.status)), answer.get("message", ""))
        return _Stream(connection, response)

    def files(self, method: str, path: str, body: bytes | None = None) -> bytes:
        query = urllib.parse.urlencode({"path": path, "username": "user"})
        connection = self._door.connection(self.host, DEFAULT_TIMEOUT)
        try:
            headers = self._headers(None)
            data = None
            if body is not None:
                boundary = uuid.uuid4().hex
                headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
                data = (
                    (
                        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                        f'filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n'
                    ).encode()
                    + body
                    + f"\r\n--{boundary}--\r\n".encode()
                )
            connection.request(method, f"/files?{query}", body=data, headers=headers)
            response = connection.getresponse()
            text = response.read()
        finally:
            connection.close()
        if response.status != 200:
            raise EnvdError(str(response.status), text.decode(errors="replace"))
        return text


def _result(events: Iterator[dict[str, Any]], *, until_start: bool = False) -> tuple[int, Any]:
    """Follows a process's events: its pid, then its CommandResult or None."""

    pid = 0
    stdout = bytearray()
    stderr = bytearray()
    for message in events:
        event = message.get("event", {})
        if "start" in event:
            pid = int(event["start"]["pid"])
            if until_start:
                return pid, None
        elif "data" in event:
            data = event["data"]
            stdout += base64.b64decode(data.get("stdout", ""))
            stderr += base64.b64decode(data.get("stderr", ""))
        elif "end" in event:
            end = event["end"]
            return pid, CommandResult(
                exit_code=int(end.get("exitCode", 0)),
                stdout=stdout.decode(errors="replace"),
                stderr=stderr.decode(errors="replace"),
            )
    raise SandboxUnavailable(f"process {pid} ended without its result")


class E2bProcess:
    """A background command; dropping the handle leaves it running."""

    def __init__(self, envd: Envd, pid: int, stream: _Stream | None, timeout: float | None):
        self._envd = envd
        self.pid = pid
        self._stream = stream
        self._timeout = timeout

    @property
    def process_id(self) -> str:
        return str(self.pid)

    def disconnect(self) -> None:
        if self._stream is not None:
            self._stream.close()
            self._stream = None

    def read_output(self, offset: int = 0) -> tuple[bytes, int, bool]:
        raise SmokeConfigurationError("E2B offers no output by offset")

    def wait(self) -> CommandResult:
        stream = self._stream or self._envd.stream(
            "process.Process/Connect", {"process": {"pid": self.pid}}, self._timeout
        )
        try:
            _, result = _result(stream.messages())
        finally:
            stream.close()
            self._stream = None
        return result


class E2bFiles:
    """E2B's file access inside a sandbox."""

    def __init__(self, envd: Envd) -> None:
        self._envd = envd

    def read(self, path: str, *, request_timeout: float | None = None) -> str:
        return self.read_bytes(path).decode(errors="replace")

    def read_bytes(self, path: str, *, request_timeout: float | None = None) -> bytes:
        return self._envd.files("GET", path)

    def write(self, path: str, data: str | bytes | IO[bytes]) -> EntryInfo:
        content = data.encode() if isinstance(data, str) else data
        content = content if isinstance(content, bytes) else content.read()
        self._envd.files("POST", path, content)
        return EntryInfo(name=path.rsplit("/", 1)[-1], path=path, type="file")

    def exists(self, path: str) -> bool:
        try:
            self._envd.unary("filesystem.Filesystem/Stat", {"path": path})
        except EnvdError as error:
            if error.code == "not_found":
                return False
            raise
        return True

    def make_dir(self, path: str) -> bool:
        try:
            self._envd.unary("filesystem.Filesystem/MakeDir", {"path": path})
        except EnvdError as error:
            if error.code == "already_exists":
                return False
            raise
        return True

    def remove(self, path: str) -> None:
        self._envd.unary("filesystem.Filesystem/Remove", {"path": path})

    def rename(self, old_path: str, new_path: str) -> EntryInfo:
        moved = self._envd.unary(
            "filesystem.Filesystem/Move", {"source": old_path, "destination": new_path}
        )
        entry = moved.get("entry", {})
        return EntryInfo(
            entry.get("name", new_path.rsplit("/", 1)[-1]),
            entry.get("path", new_path),
            ENTRY_TYPES.get(entry.get("type", ""), "file"),
        )

    def list(self, path: str) -> list[EntryInfo]:
        listed = self._envd.unary("filesystem.Filesystem/ListDir", {"path": path, "depth": 1})
        return [
            EntryInfo(e["name"], e["path"], ENTRY_TYPES.get(e.get("type", ""), "file"))
            for e in listed.get("entries", [])
        ]


class E2bWatch:
    """A live directory watcher; events are collected on a thread.

    envd's watch messages carry one of `start`, `filesystem` or `keepalive`
    at the top level. Like the SDK, the watcher is ready only once `start`
    came: a write before then may go unseen."""

    def __init__(self, stream: _Stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._events: list[FilesystemEvent] = []
        self._error: BaseException | None = None
        self._stopped = threading.Event()
        self._started = threading.Event()
        self._thread = threading.Thread(target=self._read, name="watch", daemon=True)
        self._thread.start()

    def _read(self) -> None:
        try:
            for message in self._stream.messages():
                if "start" in message:
                    self._started.set()
                change = message.get("filesystem")
                if change is not None:
                    with self._lock:
                        self._events.append(
                            FilesystemEvent(change.get("name", ""), change.get("type", ""))
                        )
        except BaseException as error:  # noqa: BLE001 - surfaced by get_new_events
            if not self._stopped.is_set():
                self._error = error
        finally:
            self._started.set()

    def wait_started(self, timeout: float) -> None:
        if not self._started.wait(timeout) or self._error is not None:
            self.stop()
            raise SandboxUnavailable(f"the watcher did not start: {self._error}")

    def get_new_events(self) -> list[FilesystemEvent]:
        with self._lock:
            events, self._events = self._events, []
        if not events and self._error is not None:
            raise SandboxUnavailable(f"watcher stopped: {self._error}")
        return events

    def alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self) -> None:
        self._stopped.set()
        self._stream.close()
        self._thread.join(5)


class E2bSandbox:
    """One sandbox, through the front door; see the module's notes."""

    # envd keeps no result of a command that ended while no one followed it.
    keeps_ended_processes = False

    def __init__(
        self,
        door: FrontDoor,
        host: HostAgent | None,
        created: Mapping[str, Any],
        *,
        timeout: int,
    ) -> None:
        self._door = door
        self.host = host
        self.sandbox_id = str(created["sandboxID"])
        self.timeout = timeout
        self._envd = Envd(door, self.sandbox_id, created.get("envdAccessToken"))
        self.files = E2bFiles(self._envd)

    def _start(
        self, command: str, envs: Mapping[str, str] | None, cwd: str | None, timeout: float | None
    ) -> _Stream:
        process: dict[str, Any] = {"cmd": "/bin/bash", "args": ["-l", "-c", command]}
        if envs:
            process["envs"] = dict(envs)
        if cwd:
            process["cwd"] = cwd
        return self._envd.stream("process.Process/Start", {"process": process}, timeout)

    def run(
        self,
        command: str,
        *,
        timeout: float = 60,
        envs: Mapping[str, str] | None = None,
        cwd: str | None = None,
    ) -> CommandResult:
        stream = self._start(command, envs, cwd, timeout + DEFAULT_TIMEOUT)
        try:
            _, result = _result(stream.messages())
        finally:
            stream.close()
        return result

    def ping(self, *, timeout: float = DEFAULT_TIMEOUT) -> int:
        deadline = time.monotonic() + timeout
        while True:
            try:
                return self.run("echo $$", timeout=10).exit_code
            except (OSError, EnvdError, SandboxUnavailable):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)

    def restore_count(self, *, timeout: float = DEFAULT_TIMEOUT) -> int:
        raise SmokeConfigurationError("the e2b target has no restore count")

    def start_background(self, command: str, *, timeout: float = 60) -> E2bProcess:
        stream = self._start(command, None, None, None)
        pid, _ = _result(stream.messages(), until_start=True)
        return E2bProcess(self._envd, pid, stream, timeout)

    def connect_process(self, pid: int, *, timeout: float = 60) -> E2bProcess:
        if not any(process.pid == pid for process in self.list_processes()):
            raise SandboxUnavailable(f"process {pid} is not running")
        stream = self._envd.stream("process.Process/Connect", {"process": {"pid": pid}}, timeout)
        return E2bProcess(self._envd, pid, stream, timeout)

    def list_processes(self, *, include_ended: bool = False) -> tuple[ProcessInfo, ...]:
        listed = self._envd.unary("process.Process/List", {})
        return tuple(
            ProcessInfo(int(p["pid"]), " ".join(p.get("config", {}).get("args", [])))
            for p in listed.get("processes", [])
        )

    def get_process(self, process_id: str) -> ProcessInfo | None:
        return next((p for p in self.list_processes() if p.process_id == process_id), None)

    def signal_process(self, process_id: str, signal_number: int) -> bool:
        name = SIGNALS.get(signal_number)
        if name is None:
            raise SmokeConfigurationError(f"E2B sends only TERM and KILL, not {signal_number}")
        try:
            self._envd.unary(
                "process.Process/SendSignal", {"process": {"pid": int(process_id)}, "signal": name}
            )
        except EnvdError as error:
            if error.code == "not_found":
                return False
            raise
        return True

    def watch_dir(self, path: str, *, recursive: bool = False) -> E2bWatch:
        stream = self._envd.stream(
            "filesystem.Filesystem/WatchDir", {"path": path, "recursive": recursive}, None
        )
        watch = E2bWatch(stream)
        watch.wait_started(10)
        return watch

    def try_get_info(self) -> SandboxInfo | None:
        try:
            info = self._door.rest("GET", f"/sandboxes/{self.sandbox_id}")
        except FrontDoorError as error:
            if error.status == 404:
                return None
            raise
        state = SandboxState.PAUSED if info["state"] == "paused" else SandboxState.RUNNING
        entry = self.host.sandbox(self.sandbox_id) if self.host is not None else None
        if entry is None:
            return SandboxInfo(
                self.sandbox_id, state, state.value, "unknown", False, None, 0, False
            )
        observed = SandboxInfo.from_status(self.sandbox_id, entry)
        return SandboxInfo(
            sandbox_id=self.sandbox_id,
            state=state,
            level=observed.level,
            durability=observed.durability,
            memory_saved=observed.memory_saved,
            step=observed.step,
            holds=observed.holds,
            broken=observed.broken,
            launches=observed.launches,
        )

    def get_info(self) -> SandboxInfo:
        info = self.try_get_info()
        if info is None:
            raise SandboxUnavailable(f"sandbox {self.sandbox_id} does not exist")
        return info

    def connect(self, *, timeout: float | None = None) -> str | None:
        self._door.rest(
            "POST", f"/v2/sandboxes/{self.sandbox_id}/connect", {"timeout": self.timeout}
        )
        return None

    def set_timeout(self, seconds: float) -> None:
        """Moves the deadline to `seconds` from now; a paused sandbox resumes
        first, as E2B's connect with a timeout does."""

        body = {"timeout": max(1, round(seconds))}
        try:
            self._door.rest("POST", f"/sandboxes/{self.sandbox_id}/timeout", body)
        except FrontDoorError as error:
            if error.status != 409:
                raise
            self._door.rest("POST", f"/v2/sandboxes/{self.sandbox_id}/connect", body)

    def refresh(self) -> None:
        self.set_timeout(self.timeout)

    def sleep(self, level: str) -> None:
        """A pause for `paused` and `saved`, which saves it to disk; deeper
        levels go on to the fleet's own sleep request."""

        self.pause()
        if level not in ("paused", "compressed", "saved"):
            raise SmokeConfigurationError(f"E2B pauses; it does not sleep to {level}")

    def pause(self) -> None:
        try:
            self._door.rest("POST", f"/sandboxes/{self.sandbox_id}/pause")
        except FrontDoorError as error:
            # Already paused.
            if error.status != 409:
                raise

    def kill(self) -> None:
        self._door.rest("DELETE", f"/sandboxes/{self.sandbox_id}")


@dataclass(frozen=True)
class E2bServices:
    """What scenarios run against: the front door, and the host agent to
    observe."""

    door: FrontDoor
    host: HostAgent | None
    template: str = "base"
    restart_command: None = None

    @classmethod
    def from_environment(cls, host: HostAgent | None) -> E2bServices:
        return cls(
            FrontDoor.from_environment(),
            host,
            os.environ.get("COMPUTE_SMOKE_E2B_TEMPLATE", "base"),
        )

    def fixture(
        self,
        fixture_type: Any,
        context: ScenarioContext,
        *,
        scenario_id: str,
        sandbox: SandboxConfig,
        sandbox_count: int,
    ) -> Any:
        """Create the scenario's sandboxes through the front door, wait until
        each answers, and register their removal with the scenario's cleanup."""

        context.record("scenario_id", scenario_id)
        sandboxes: list[E2bSandbox] = []
        for _ in range(sandbox_count):
            created = self.door.rest(
                "POST",
                "/v2/sandboxes",
                {
                    "templateID": self.template,
                    "timeout": sandbox.timeout,
                    "autoPause": True,
                    "autoResume": {"enabled": True},
                    "metadata": {"scenario": scenario_id},
                },
            )
            handle = E2bSandbox(self.door, self.host, created, timeout=sandbox.timeout)
            context.scope.defer(
                f"kill sandbox {handle.sandbox_id}",
                lambda handle=handle: self._kill(handle),
                critical=True,
            )
            sandboxes.append(handle)
            context.record("sandbox_ids", [s.sandbox_id for s in sandboxes])
        started = time.monotonic()
        for handle in sandboxes:
            handle.ping(timeout=READY_TIMEOUT_SECONDS)
        context.record("sandbox_ready_seconds", time.monotonic() - started)
        return fixture_type(context, sandboxes[0], self, tuple(sandboxes), sandbox.timeout)

    def _kill(self, handle: E2bSandbox) -> None:
        try:
            handle.kill()
        except FrontDoorError as error:
            if error.status != 404:
                raise

    def restart_host_agent(self, context: ScenarioContext) -> None:
        raise SmokeConfigurationError("the e2b target does not restart host agents")
