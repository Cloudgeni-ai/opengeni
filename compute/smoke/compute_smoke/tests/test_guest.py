"""The reference guest service's protocol, exercised over a Unix socket on
the host instead of vsock inside a VM."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

GUEST = Path(__file__).resolve().parents[2] / "guest" / "smoke_guest.py"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text)


class GuestService(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Short path: Unix socket addresses are limited to about 100 bytes.
        cls.scratch = Path(tempfile.mkdtemp(prefix="smoke-guest-", dir="/tmp"))
        cls.address = str(cls.scratch / "guest.sock")
        cls.notice_address = str(cls.scratch / "notice.sock")
        cls.service = subprocess.Popen(
            [
                sys.executable,
                str(GUEST),
                "--listen",
                f"unix:{cls.address}",
                "--notice",
                f"unix:{cls.notice_address}",
                "--keep-clock",
            ],
            env={
                **os.environ,
                **_identity_files(cls.scratch),
                "SMOKE_GUEST_STATE": str(cls.scratch / "state"),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        while True:
            try:
                cls.request({"op": "ping"})
                break
            except OSError:
                if cls.service.poll() is not None or time.monotonic() > deadline:
                    cls.tearDownClass()
                    raise
                time.sleep(0.02)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.service.kill()
        cls.service.wait()
        shutil.rmtree(cls.scratch, ignore_errors=True)

    @classmethod
    def connect(cls) -> socket.socket:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.settimeout(10)
            connection.connect(cls.address)
        except OSError:
            connection.close()
            raise
        return connection

    @classmethod
    def request(cls, message: dict[str, Any]) -> dict[str, Any]:
        """Sends one request on its own connection and returns the answer."""

        return cls.raw(json.dumps(message).encode() + b"\n")

    @classmethod
    def raw(cls, line: bytes) -> dict[str, Any]:
        with cls.connect() as connection, connection.makefile("rb") as reader:
            connection.sendall(line)
            return json.loads(reader.readline())

    def ok(self, message: dict[str, Any]) -> dict[str, Any]:
        reply = self.request(message)
        self.assertTrue(reply.pop("ok"), reply)
        return reply

    def refused(self, message: dict[str, Any]) -> str:
        reply = self.request(message)
        self.assertFalse(reply["ok"], reply)
        return reply["error"]

    def path(self, name: str) -> str:
        return str(self.scratch / "files" / self.id().rsplit(".", 1)[-1] / name)

    def test_ping_names_the_serving_process(self) -> None:
        self.assertEqual(self.ok({"op": "ping"})["pid"], self.service.pid)

    def notice(self, line: bytes) -> bytes:
        """Sends one restore notice and returns everything the guest answers."""

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(self.notice_address)
            connection.sendall(line)
            connection.shutdown(socket.SHUT_WR)
            answer = b""
            while chunk := connection.recv(64):
                answer += chunk
            return answer

    def test_restore_notices_are_acknowledged_and_counted(self) -> None:
        before = self.ok({"op": "ping"})["restores"]
        self.assertEqual(self.notice(f"restored {time.time_ns()}\n".encode()), b"ok\n")
        self.assertEqual(self.notice(f"restored {time.time_ns()}\n".encode()), b"ok\n")
        self.assertEqual(self.ok({"op": "ping"})["restores"], before + 2)

    def test_a_malformed_restore_notice_is_neither_answered_nor_counted(self) -> None:
        before = self.ok({"op": "ping"})["restores"]
        too_long = f"restored {time.time_ns()} sandbox={'a' * 1024}\n".encode()
        for line in (b"restored\n", b"restored soon\n", b"hello 1\n", b"", too_long):
            with self.subTest(line=line):
                self.assertEqual(self.notice(line), b"")
        self.assertEqual(self.ok({"op": "ping"})["restores"], before)

    def test_a_restore_notice_names_the_sandbox_and_unknown_fields_are_ignored(self) -> None:
        before = self.ok({"op": "ping"})["restores"]
        sandbox = "0123456789abcdef0123456789abcdef"
        line = f"restored {time.time_ns()} sandbox={sandbox} later=1 bare\n".encode()
        self.assertEqual(self.notice(line), b"ok\n")
        reply = self.ok({"op": "ping"})
        self.assertEqual(reply["restores"], before + 1)
        self.assertEqual(reply["sandbox"], sandbox)
        # A notice without the field keeps the id the guest already has.
        self.assertEqual(self.notice(f"restored {time.time_ns()}\n".encode()), b"ok\n")
        self.assertEqual(self.ok({"op": "ping"})["sandbox"], sandbox)

    def test_two_clones_get_machine_ids_and_hostnames_of_their_own(self) -> None:
        machine_id = self.scratch / "machine-id"
        hostname = self.scratch / "hostname"
        seen = set()
        for sandbox, seed in (("c10e0001", "5eed01"), ("c10e0002", "5eed02")):
            line = f"restored {time.time_ns()} sandbox={sandbox} seed={seed}\n".encode()
            self.notice(line)
            first = machine_id.read_text()
            self.assertRegex(first, r"^[0-9a-f]{32}\n$")
            self.assertEqual(hostname.read_text(), f"{sandbox}\n")
            seen.add(first)
            # A retried notice, or a later restore of the same sandbox with
            # a new seed, keeps the machine id.
            self.notice(line)
            self.notice(f"restored {time.time_ns()} sandbox={sandbox} seed=0ther\n".encode())
            self.assertEqual(machine_id.read_text(), first)
        self.assertEqual(len(seen), 2, "two clones share a machine id")

    def test_output_resumes_from_a_cursor(self) -> None:
        pid = self.ok({"op": "spawn", "command": "printf one; sleep 0.3; printf two"})["pid"]
        deadline = time.monotonic() + 10
        seen, offset, eof = b"", 0, False
        while not eof:
            self.assertLess(time.monotonic(), deadline)
            reply = self.ok({"op": "output", "pid": pid, "offset": offset})
            seen += _unb64(reply["data"])
            offset, eof = reply["offset"], reply["eof"]
            if seen == b"one":
                # Every read is its own connection: a later one picks up
                # from the cursor, whoever dropped the last.
                self.assertTrue(reply["running"])
        self.assertEqual((seen, offset), (b"onetwo", 6))
        # An ended command's output takes several reads at a small limit:
        # only the last says it is the end.
        pages = []
        offset = 0
        while not pages or not pages[-1]["eof"]:
            pages.append(self.ok({"op": "output", "pid": pid, "offset": offset, "limit": 4}))
            offset = pages[-1]["offset"]
        self.assertEqual(b"".join(_unb64(page["data"]) for page in pages), b"onetwo")
        self.assertEqual([page["running"] for page in pages], [False, False])
        self.assertEqual([page["eof"] for page in pages], [False, True])
        reply = self.ok({"op": "output", "pid": pid, "offset": 3, "limit": 2})
        self.assertEqual((_unb64(reply["data"]), reply["offset"]), (b"tw", 5))
        self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertFalse(self.request({"op": "output", "pid": pid})["ok"], "collected")

    def commands(self) -> bytes:
        return self.notice(b"activity\n")

    def test_running_commands_keep_the_sandbox_awake_unless_asked_not_to(self) -> None:
        self.assertEqual(self.commands(), b"commands 0\n")
        quiet = self.ok({"op": "spawn", "command": "sleep 30"})["pid"]
        forgotten = self.ok({"op": "spawn", "command": "sleep 30", "keep_awake": False})["pid"]
        self.assertEqual(self.commands(), b"commands 1\n", "fire and forget does not count")
        for pid in (quiet, forgotten):
            self.ok({"op": "signal", "pid": pid, "signal": signal.SIGKILL})
            self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertEqual(self.commands(), b"commands 0\n", "an ended command does not count")

        # A foreground command counts while it runs.
        marker = Path(self.path("started"))
        marker.parent.mkdir(parents=True, exist_ok=True)
        running = threading.Thread(
            target=self.ok, args=({"op": "exec", "command": f"touch {marker}; sleep 1"},)
        )
        running.start()
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.commands(), b"commands 1\n")
        running.join()
        self.assertEqual(self.commands(), b"commands 0\n")

    def test_a_command_returns_its_status_and_both_streams(self) -> None:
        reply = self.ok(
            {
                "op": "exec",
                "command": 'printf out; printf err >&2; printf %s "$GREETING" >&2; exit 3',
                "env": {"GREETING": "-hi"},
            }
        )
        self.assertEqual(reply["exit_code"], 3)
        self.assertEqual(_unb64(reply["stdout"]), b"out")
        self.assertEqual(_unb64(reply["stderr"]), b"err-hi")

    @unittest.skipUnless(sys.platform.startswith("linux"), "oom_score_adj is Linux's")
    def test_the_service_outlasts_its_commands_when_memory_runs_out(self) -> None:
        read = "cat /proc/self/oom_score_adj"
        ran = self.ok({"op": "exec", "command": read})
        self.assertEqual(_unb64(ran["stdout"]).strip(), b"0", "a command starts unprotected")
        pid = self.ok({"op": "spawn", "command": read})["pid"]
        spawned = self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertEqual(_unb64(spawned["stdout"]).strip(), b"0", "so does a background one")
        protected = self.ok({"op": "ping"})["oom_score_adj"]
        if os.geteuid() != 0:
            self.skipTest(f"only root may protect the service (it reads {protected})")
        self.assertEqual(protected, -1000)

    def test_a_command_runs_in_the_requested_directory(self) -> None:
        reply = self.ok({"op": "exec", "command": "pwd -P", "cwd": str(self.scratch)})
        self.assertEqual(_unb64(reply["stdout"]).strip(), str(self.scratch.resolve()).encode())

    def test_a_command_past_its_timeout_is_killed_with_its_children(self) -> None:
        marker = Path(self.path("late"))
        marker.parent.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        error = self.refused(
            {
                "op": "exec",
                "command": f"(sleep 1; touch {marker}) & sleep 30",
                "timeout": 0.3,
            }
        )
        self.assertIn("timed out", error)
        self.assertLess(time.monotonic() - started, 5)
        time.sleep(1.5)
        self.assertFalse(marker.exists(), "a child of the timed-out command survived")

    def test_a_background_process_outlives_its_connection_and_reports_its_output(
        self,
    ) -> None:
        pid = self.ok(
            {
                "op": "spawn",
                "command": "read -t 30 line < /dev/null; sleep 0.5; echo done",
            }
        )["pid"]
        listed = self.ok({"op": "processes"})["processes"]
        self.assertIn(pid, [process["pid"] for process in listed])
        result = self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(_unb64(result["stdout"]), b"done\n")
        self.assertNotIn(
            pid,
            [process["pid"] for process in self.ok({"op": "processes"})["processes"]],
        )
        # Waiting forgets the process unless asked to keep it.
        self.assertIn("no process", self.refused({"op": "wait", "pid": pid}))

    def test_an_ended_process_stays_listed_until_its_result_is_collected(self) -> None:
        pid = self.ok({"op": "spawn", "command": "printf finished"})["pid"]
        deadline = time.monotonic() + 10
        while True:
            every = {p["pid"]: p for p in self.ok({"op": "processes", "all": True})["processes"]}
            self.assertIn(pid, every)
            if not every[pid]["running"] or time.monotonic() > deadline:
                break
            time.sleep(0.02)
        self.assertEqual(every[pid]["running"], False)
        self.assertNotIn(pid, [p["pid"] for p in self.ok({"op": "processes"})["processes"]])
        result = self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertEqual(_unb64(result["stdout"]), b"finished")
        self.assertNotIn(
            pid,
            [p["pid"] for p in self.ok({"op": "processes", "all": True})["processes"]],
        )
        self.assertIn("must be bool", self.refused({"op": "processes", "all": 1}))

    def test_waiting_on_a_running_process_times_out_without_forgetting_it(self) -> None:
        pid = self.ok({"op": "spawn", "command": "sleep 30"})["pid"]
        self.assertIn("still running", self.refused({"op": "wait", "pid": pid, "timeout": 0.1}))
        self.assertEqual(
            self.ok({"op": "signal", "pid": pid, "signal": signal.SIGTERM}),
            {"delivered": True},
        )
        result = self.ok({"op": "wait", "pid": pid, "timeout": 10})
        self.assertEqual(result["exit_code"], -signal.SIGTERM)

    def test_signalling_an_exited_process_reports_no_delivery(self) -> None:
        pid = self.ok({"op": "spawn", "command": "true"})["pid"]
        self.ok({"op": "wait", "pid": pid, "timeout": 10, "forget": False})
        self.assertEqual(
            self.ok({"op": "signal", "pid": pid, "signal": signal.SIGTERM}),
            {"delivered": False},
        )
        self.ok({"op": "wait", "pid": pid})

    def test_killing_a_background_command_kills_its_children(self) -> None:
        marker = Path(self.path("late"))
        marker.parent.mkdir(parents=True, exist_ok=True)
        pid = self.ok({"op": "spawn", "command": f"(sleep 1; touch {marker}) & wait"})["pid"]
        self.assertEqual(
            self.ok({"op": "signal", "pid": pid, "signal": signal.SIGKILL}),
            {"delivered": True},
        )
        self.assertEqual(self.ok({"op": "wait", "pid": pid, "timeout": 10})["exit_code"], -9)
        time.sleep(1.5)
        self.assertFalse(marker.exists(), "a child of the killed command survived")

    def test_binary_files_round_trip_byte_for_byte(self) -> None:
        data = bytes(range(256)) * 1024 + b"\0\n\r"
        path = self.path("nested/dir/blob.bin")
        self.assertEqual(
            self.ok({"op": "write", "path": path, "data": _b64(data)})["bytes"],
            len(data),
        )
        self.assertEqual(_unb64(self.ok({"op": "read", "path": path})["data"]), data)

    def test_reading_a_missing_file_is_refused(self) -> None:
        self.assertIn("no such file", self.refused({"op": "read", "path": self.path("missing")}))

    def test_directories_can_be_made_listed_renamed_and_removed(self) -> None:
        root = self.path("tree")
        self.assertEqual(self.ok({"op": "mkdir", "path": f"{root}/a/b"}), {"created": True})
        self.assertEqual(self.ok({"op": "mkdir", "path": f"{root}/a/b"}), {"created": False})
        self.ok({"op": "write", "path": f"{root}/a/file.txt", "data": _b64(b"x")})
        entries = self.ok({"op": "list", "path": f"{root}/a"})["entries"]
        self.assertEqual(
            [(entry["name"], entry["type"]) for entry in entries],
            [("b", "dir"), ("file.txt", "file")],
        )
        self.ok(
            {
                "op": "rename",
                "source": f"{root}/a/file.txt",
                "target": f"{root}/c/moved.txt",
            }
        )
        self.assertEqual(self.ok({"op": "exists", "path": f"{root}/a/file.txt"}), {"exists": False})
        self.assertEqual(self.ok({"op": "exists", "path": f"{root}/c/moved.txt"}), {"exists": True})
        self.ok({"op": "remove", "path": f"{root}/a"})
        self.assertEqual(self.ok({"op": "exists", "path": f"{root}/a/b"}), {"exists": False})
        # Removing what is already gone succeeds.
        self.ok({"op": "remove", "path": f"{root}/a"})
        self.assertIn(
            "not a directory",
            self.refused({"op": "list", "path": f"{root}/c/moved.txt"}),
        )

    def test_malformed_requests_are_refused_with_a_reason(self) -> None:
        self.assertIn("unknown op", self.refused({"op": "format-disk"}))
        self.assertIn("must be str", self.refused({"op": "exec", "command": 7}))
        self.assertIn("must be int", self.refused({"op": "wait", "pid": True}))
        self.assertIn(
            "must map strings",
            self.refused({"op": "exec", "command": "true", "env": {"A": 1}}),
        )
        self.assertFalse(self.raw(b"[1, 2]\n")["ok"])
        self.assertFalse(self.raw(b"{not json\n")["ok"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_recursive_watch_reports_changes_in_new_subdirectories(self) -> None:
        root = Path(self.path("watched"))
        root.mkdir(parents=True)
        with self.connect() as connection, connection.makefile("rb") as reader:
            connection.sendall(
                json.dumps({"op": "watch", "path": str(root), "recursive": True}).encode() + b"\n"
            )
            self.assertEqual(json.loads(reader.readline()), {"ok": True})
            (root / "sub").mkdir()
            self.assertEqual(json.loads(reader.readline()), {"name": "sub", "type": "create"})
            # The new directory is watched before the next change in it.
            time.sleep(0.2)
            (root / "sub" / "file").write_bytes(b"x")
            events = set()
            while ("sub/file", "write") not in events:
                event = json.loads(reader.readline())
                events.add((event["name"], event["type"]))
            self.assertIn(("sub/file", "create"), events)

    def watch(self, root: Path) -> tuple[socket.socket, Any]:
        connection = self.connect()
        reader = connection.makefile("rb")
        connection.sendall(
            json.dumps({"op": "watch", "path": str(root), "recursive": True}).encode() + b"\n"
        )
        self.assertEqual(json.loads(reader.readline()), {"ok": True})
        return connection, reader

    @staticmethod
    def events_until(reader: Any, name: str) -> list[tuple[str, str]]:
        """Reads events up to and including the first one about `name`."""

        events = []
        while True:
            event = json.loads(reader.readline())
            events.append((event["name"], event["type"]))
            if event["name"] == name:
                return events

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_watch_ends_when_the_client_closes_without_further_changes(self) -> None:
        root = Path(self.path("watched"))
        root.mkdir(parents=True)
        connection, reader = self.watch(root)
        with connection, reader:
            # What the host agent's proxy does when the client goes away.
            connection.shutdown(socket.SHUT_WR)
            connection.settimeout(5)
            self.assertEqual(reader.read(), b"", "the guest closes its side at once")

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_populated_directory_moved_in_is_watched_all_the_way_down(self) -> None:
        root = Path(self.path("watched"))
        root.mkdir(parents=True)
        outside = Path(self.path("outside"))
        (outside / "inner" / "deep").mkdir(parents=True)
        connection, reader = self.watch(root)
        with connection, reader:
            os.rename(outside, root / "arrived")
            self.events_until(reader, "arrived")
            time.sleep(0.2)
            (root / "arrived" / "inner" / "deep" / "file").write_bytes(b"x")
            events = self.events_until(reader, "arrived/inner/deep/file")
            self.assertIn(("arrived/inner/deep/file", "create"), events)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_renamed_inside_the_tree_reports_its_new_paths(self) -> None:
        root = Path(self.path("watched"))
        (root / "old" / "inner").mkdir(parents=True)
        connection, reader = self.watch(root)
        with connection, reader:
            os.rename(root / "old", root / "new")
            self.events_until(reader, "new")
            (root / "new" / "inner" / "file").write_bytes(b"x")
            events = self.events_until(reader, "new/inner/file")
            self.assertNotIn("old/inner/file", [name for name, _ in events])

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_moved_out_of_the_tree_is_no_longer_reported(self) -> None:
        root = Path(self.path("watched"))
        (root / "leaving" / "inner").mkdir(parents=True)
        outside = Path(self.path("outside"))
        outside.mkdir(parents=True)
        connection, reader = self.watch(root)
        with connection, reader:
            os.rename(root / "leaving", outside / "left")
            self.events_until(reader, "leaving")
            time.sleep(0.2)
            (outside / "left" / "inner" / "file").write_bytes(b"x")
            # A change in the tree marks the end of anything the move left.
            (root / "fence").write_bytes(b"x")
            events = self.events_until(reader, "fence")
            self.assertEqual(
                [name for name, _ in events if name.startswith("leaving")],
                [],
                "a directory moved away is still reported under its old path",
            )


def _identity_files(scratch: Path) -> dict[str, str]:
    """Where a guest under test keeps the machine id and hostname a clone
    renews, and whom they were made for, in place of the host's."""

    return {
        "SMOKE_GUEST_MACHINE_ID": str(scratch / "machine-id"),
        "SMOKE_GUEST_HOSTNAME": str(scratch / "hostname"),
        "SMOKE_GUEST_IDENTITY": str(scratch / "identity"),
    }


def _load_guest(state: Path) -> Any:
    """Imports the guest service as a module, keeping its files in `state`."""

    with mock.patch.dict(
        os.environ, {**_identity_files(state.parent), "SMOKE_GUEST_STATE": str(state)}
    ):
        spec = importlib.util.spec_from_file_location("smoke_guest_under_test", GUEST)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class GuestInternals(unittest.TestCase):
    """Cases a running service cannot be steered into, driven in-process."""

    def setUp(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="smoke-guest-in-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.guest = _load_guest(self.scratch / "state")
        self.now = 0.0

    def test_a_seed_is_mixed_in_and_the_generator_reseeded(self) -> None:
        pool = self.scratch / "pool"
        pool.touch()
        seed = "00ff" * 16
        with mock.patch.object(self.guest.fcntl, "ioctl") as ioctl:
            self.assertTrue(self.guest.reseed(seed, str(pool)))
        self.assertEqual(pool.read_bytes(), bytes.fromhex(seed))
        self.assertEqual(ioctl.call_args.args[1], self.guest.RNDRESEEDCRNG)
        with mock.patch.object(self.guest.fcntl, "ioctl", side_effect=OSError("denied")):
            self.assertFalse(self.guest.reseed(seed, str(pool)))
        for bad in ("", "xyz"):
            with self.subTest(seed=bad):
                self.assertFalse(self.guest.reseed(bad, str(pool)))

    def test_the_answer_says_whether_the_seed_was_applied(self) -> None:
        def answer(line: bytes, applied: bool) -> tuple[bytes, list[str]]:
            seeds: list[str] = []

            def reseed(seed: str) -> bool:
                seeds.append(seed)
                return applied

            host, guest = socket.socketpair()
            with host, mock.patch.object(self.guest, "reseed", reseed):
                host.sendall(line)
                self.guest.serve_notice(guest, set_clock=False)
                return host.recv(64), seeds

        now = time.time_ns()
        line = f"restored {now} sandbox=ab seed=5eed\n".encode()
        self.assertEqual(answer(line, True), (b"ok seeded\n", ["5eed"]))
        self.assertEqual(answer(line, False), (b"ok\n", ["5eed"]))
        self.assertEqual(answer(f"restored {now}\n".encode(), True), (b"ok\n", []))

    def test_a_clone_that_cannot_renew_its_identity_is_not_seeded_and_keeps_its_old_id(
        self,
    ) -> None:
        self.guest.RESTORES.record("7e3a")
        host, guest = socket.socketpair()
        with (
            host,
            mock.patch.object(self.guest, "renew_identity", return_value=False),
            mock.patch.object(self.guest, "reseed", return_value=True),
        ):
            host.sendall(f"restored {time.time_ns()} sandbox=c10e seed=5eed\n".encode())
            self.guest.serve_notice(guest, set_clock=False)
            self.assertEqual(host.recv(64), b"ok\n")
        # Not taken, so the host's retry renews again.
        self.assertEqual(self.guest.RESTORES.sandbox(), "7e3a")

    def notice(self, nanos: int, sandbox: str, order: str) -> bytes:
        """Serves one seeded restore notice in-process; returns the answer."""

        host, guest = socket.socketpair()
        line = f"restored {nanos} sandbox={sandbox} seed=5eed order={order}\n"
        with host, mock.patch.object(self.guest, "reseed", return_value=True):
            host.sendall(line.encode())
            self.guest.serve_notice(guest, set_clock=False)
            return host.recv(64)

    def test_a_late_notice_never_takes_back_a_newer_identity(self) -> None:
        machine_id, hostname = self.scratch / "machine-id", self.scratch / "hostname"
        # The host's clock steps back between the attempts: the first
        # notice for ready identity A is stamped 300 and delayed; its retry
        # at 100 is acknowledged, then the claim for B at 200, then the
        # first attempt arrives. Its time is the newest, its order is not.
        self.assertEqual(self.notice(100, "a", "3.4"), b"ok seeded\n")
        self.assertEqual(self.notice(200, "b", "3.5"), b"ok seeded\n")
        claimed = machine_id.read_text()
        self.assertEqual(self.notice(300, "a", "3.4"), b"", "the late notice is refused")
        self.assertEqual(self.guest.RESTORES.sandbox(), "b")
        self.assertEqual(machine_id.read_text(), claimed)
        self.assertEqual(hostname.read_text(), "b\n")
        # A later execution orders above any revision of an earlier one.
        self.assertEqual(self.notice(50, "b", "4.1"), b"ok seeded\n")
        self.assertEqual(self.notice(400, "b", "3.9"), b"")

    def test_notices_order_by_the_host_not_by_the_clock(self) -> None:
        # Equal times: the order decides, and a retry of the latest notice
        # is applied again.
        self.assertEqual(self.notice(100, "a", "1.2"), b"ok seeded\n")
        self.assertEqual(self.notice(100, "b", "1.3"), b"ok seeded\n")
        self.assertEqual(self.notice(100, "a", "1.2"), b"")
        self.assertEqual(self.notice(100, "b", "1.3"), b"ok seeded\n")
        self.assertEqual(self.guest.RESTORES.sandbox(), "b")
        # Revisions compare as numbers, not as text.
        self.assertEqual(self.notice(100, "c", "1.10"), b"ok seeded\n")
        self.assertEqual(self.notice(100, "b", "1.9"), b"")
        self.assertEqual(self.guest.RESTORES.sandbox(), "c")

    def test_a_notice_order_is_two_numbers(self) -> None:
        order = self.guest.notice_order
        self.assertEqual(order({"order": "12.345"}), (12, 345))
        for bad in ("", "12", "12.", ".3", "1.2.3", "a.b", "-1.2"):
            with self.subTest(order=bad):
                self.assertIsNone(order({"order": bad}))
        self.assertIsNone(order({}))

    def test_notices_are_applied_one_at_a_time(self) -> None:
        notices = self.guest.Notices()
        entered, release = threading.Event(), threading.Event()
        order: list[str] = []

        def slow() -> bytes:
            entered.set()
            release.wait(10)
            order.append("a")
            return b"ok\n"

        def later() -> bytes:
            order.append("b")
            return b"ok\n"

        first = threading.Thread(target=notices.apply, args=((1, 2), slow))
        first.start()
        self.assertTrue(entered.wait(10))
        second = threading.Thread(target=notices.apply, args=((1, 3), later))
        second.start()
        time.sleep(0.05)
        self.assertEqual(order, [], "the newer notice waits for the one under way")
        release.set()
        first.join(10)
        second.join(10)
        self.assertEqual(order, ["a", "b"])
        self.assertIsNone(notices.apply((1, 1), later), "an older one is obsolete")
        self.assertEqual(notices.apply(None, later), b"ok\n", "an unordered one is applied")

    def test_a_guest_booted_from_a_cloned_disk_makes_its_own_identity(self) -> None:
        machine_id, hostname = self.scratch / "machine-id", self.scratch / "hostname"
        # The template's guest made its identity on the disk sandbox b
        # boots from.
        self.assertTrue(self.guest.renew_identity("t", "5eed"))
        template = machine_id.read_text()
        self.guest.take_identity("b")
        own = machine_id.read_text()
        self.assertNotEqual(own, template)
        self.assertEqual(hostname.read_text(), "b\n")
        self.assertTrue(self.guest.owns_identity("b"))
        # Its own reboot keeps the machine id and sets the hostname again.
        hostname.write_text("localhost\n")
        self.guest.take_identity("b")
        self.assertEqual(machine_id.read_text(), own)
        self.assertEqual(hostname.read_text(), "b\n")

    def test_a_notice_renews_an_identity_made_for_another_sandbox(self) -> None:
        # Booted as b from a template's disk, where its startup could not
        # make its own: the host's notice for b, which it must acknowledge
        # before the sandbox runs, makes it.
        machine_id = self.scratch / "machine-id"
        self.assertTrue(self.guest.renew_identity("t", "5eed"))
        template = machine_id.read_text()
        self.guest.RESTORES.record("b")
        self.assertEqual(self.notice(time.time_ns(), "b", "1.1"), b"ok seeded\n")
        self.assertNotEqual(machine_id.read_text(), template)
        self.assertTrue(self.guest.owns_identity("b"))

    def test_signalling_an_exited_process_leaves_its_old_group_alone(self) -> None:
        process = self.guest.PROCESSES.start("true", dict(os.environ), None)
        self.addCleanup(self.guest.PROCESSES.forget, process.pid)
        self.assertTrue(process.exited.wait(10))
        with mock.patch.object(self.guest.os, "killpg") as killpg:
            reply = self.guest.op_signal({"pid": process.pid, "signal": signal.SIGTERM})
        self.assertEqual(reply, {"delivered": False})
        killpg.assert_not_called()

    def test_a_booted_guest_finds_its_sandbox_on_the_kernel_command_line(self) -> None:
        boot_sandbox = self.guest.boot_sandbox
        self.assertEqual(
            boot_sandbox("console=ttyS0 reboot=k opengeni.sandbox=00ff ip=169.254.0.21"),
            "00ff",
        )
        self.assertIsNone(boot_sandbox("console=ttyS0 reboot=k"))
        self.assertIsNone(boot_sandbox("opengeni.sandbox= opengeni.sandboxes=1"))

    def test_a_restarted_service_keeps_the_id_a_notice_gave(self) -> None:
        # A clone's kernel command line is its template's; only the notice
        # names it, so the id must outlive the service process.
        self.guest.RESTORES.record("0123456789abcdef0123456789abcdef")
        restarted = _load_guest(self.scratch / "state")
        self.assertEqual(restarted.RESTORES.sandbox(), "0123456789abcdef0123456789abcdef")

    def watcher(self) -> Any:
        """A recursive watcher on a tree with `old/inner`, on a fake clock."""

        root = self.scratch / "root"
        (root / "old" / "inner").mkdir(parents=True)
        watcher = self.guest.Inotify(root, True, clock=lambda: self.now)
        self.addCleanup(watcher.close)
        return watcher

    def event(self, watcher: Any, directory: Path, mask: int, cookie: int, name: str) -> bytes:
        """One raw inotify event, as the kernel lays it out."""

        descriptor = next(d for d, path in watcher.watched().items() if path == directory)
        raw = name.encode() + b"\0" * (16 - len(name) % 16)
        return self.guest.EVENT_HEADER.pack(descriptor, mask, cookie, len(raw)) + raw

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_rename_split_across_reads_keeps_the_directory_watched(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        isdir = self.guest.IN_ISDIR
        away = self.event(watcher, root, self.guest.IN_MOVED_FROM | isdir, 7, "old")
        back = self.event(watcher, root, self.guest.IN_MOVED_TO | isdir, 7, "new")
        self.assertEqual(watcher.parse(away), [{"name": "old", "type": "rename"}])
        self.assertIsNotNone(watcher.settle_seconds())
        self.now += self.guest.MOVE_PAIR_SECONDS / 2
        self.assertEqual(watcher.parse(back), [{"name": "new", "type": "rename"}])
        self.assertIsNone(watcher.settle_seconds())
        self.now += 1
        self.assertEqual(watcher.read_events(), [])
        self.assertIn(root / "new" / "inner", watcher.watched().values())
        self.assertNotIn(root / "old" / "inner", watcher.watched().values())

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_move_away_never_answered_ends_the_watch_after_a_grace(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        away = self.event(watcher, root, self.guest.IN_MOVED_FROM | self.guest.IN_ISDIR, 9, "old")
        watcher.parse(away)
        self.assertEqual(watcher.read_events(), [])
        self.assertIn(root / "old" / "inner", watcher.watched().values(), "too early")
        self.now += self.guest.MOVE_PAIR_SECONDS
        self.assertEqual(watcher.settle_seconds(), 0.0)
        watcher.read_events()
        self.assertNotIn(root / "old" / "inner", watcher.watched().values())
        self.assertNotIn(root / "old", watcher.watched().values())
        self.assertIsNone(watcher.settle_seconds())

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_remade_where_one_moved_out_keeps_its_watch(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        os.rename(root / "old", self.scratch / "elsewhere")
        (root / "old").mkdir()
        watcher.read_events()
        self.assertIsNotNone(watcher.settle_seconds(), "the move away is pending")
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertIn(root / "old", watcher.watched().values(), "the new directory")
        self.assertNotIn(root / "old" / "inner", watcher.watched().values())
        (root / "old" / "file").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertIn("old/file", names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_that_leaves_and_returns_renamed_keeps_its_watches(self) -> None:
        # Out and back in are two moves with two cookies; the kernel gives
        # the returning directory the watches it left with.
        watcher = self.watcher()
        root = self.scratch / "root"
        os.rename(root / "old", self.scratch / "elsewhere")
        watcher.read_events()
        self.assertIsNotNone(watcher.settle_seconds(), "the move away is pending")
        os.rename(self.scratch / "elsewhere", root / "new")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertIn(root / "new", watcher.watched().values())
        self.assertIn(root / "new" / "inner", watcher.watched().values())
        (root / "new" / "inner" / "file").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertIn("new/inner/file", names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_that_leaves_and_returns_in_one_read_keeps_its_watches(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        os.rename(root / "old", self.scratch / "elsewhere")
        os.rename(self.scratch / "elsewhere", root / "new")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertIn(root / "new" / "inner", watcher.watched().values())
        (root / "new" / "inner" / "file").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertIn("new/inner/file", names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_child_that_left_stays_gone_when_its_parent_is_renamed_meanwhile(self) -> None:
        # The parent's rename must not take over the child's pending
        # departure, or the child would stay watched outside the tree.
        watcher = self.watcher()
        root = self.scratch / "root"
        os.rename(root / "old" / "inner", self.scratch / "elsewhere")
        os.rename(root / "old", root / "new")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertIn(root / "new", watcher.watched().values())
        self.assertEqual(
            [path for path in watcher.watched().values() if path.name == "inner"],
            [],
            "the departed child is still watched",
        )
        (self.scratch / "elsewhere" / "file").touch()
        (root / "new" / "fence").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertTrue(names)
        self.assertTrue(all(name == "new/fence" for name in names), names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_rename_inside_a_departed_directory_follows_it_back(self) -> None:
        # The parent leaves (its arrival in a later read), its child is
        # renamed inside it meanwhile, then the parent arrives: the child's
        # watch ends up under the parent's new name and the child's new one.
        watcher = self.watcher()
        root = self.scratch / "root"
        isdir = self.guest.IN_ISDIR
        away = self.event(watcher, root, self.guest.IN_MOVED_FROM | isdir, 7, "old")
        old = root / "old"
        renamed = self.event(watcher, old, self.guest.IN_MOVED_FROM | isdir, 8, "inner")
        renamed += self.event(watcher, old, self.guest.IN_MOVED_TO | isdir, 8, "inner2")
        back = self.event(watcher, root, self.guest.IN_MOVED_TO | isdir, 7, "back")
        watcher.parse(away)
        watcher.parse(renamed)
        watcher.parse(back)
        self.assertIsNone(watcher.settle_seconds())
        self.assertIn(root / "back", watcher.watched().values())
        self.assertIn(root / "back" / "inner2", watcher.watched().values())
        self.assertNotIn(root / "back" / "inner", watcher.watched().values())

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_child_that_returns_while_its_parent_is_away_keeps_its_watch(self) -> None:
        # The parent's departure took the child's watch; the child coming
        # back on its own makes it the tree's again, so the parent's
        # departure must not take it along when it settles.
        watcher = self.watcher()
        root = self.scratch / "root"
        outside = self.scratch / "elsewhere"
        os.rename(root / "old", outside)
        watcher.read_events()
        os.rename(outside / "inner", root / "rescued")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertEqual(sorted(watcher.watched().values()), [root, root / "rescued"])
        (outside / "ignored").touch()
        (root / "rescued" / "file").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertTrue(names)
        self.assertTrue(all(name == "rescued/file" for name in names), names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_child_renamed_inside_a_parent_that_stays_away_goes_with_it(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        outside = self.scratch / "elsewhere"
        os.rename(root / "old", outside)
        watcher.read_events()
        os.rename(outside / "inner", outside / "inner2")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertEqual(list(watcher.watched().values()), [root])
        (outside / "inner2" / "ignored").touch()
        (root / "fence").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertTrue(names)
        self.assertTrue(all(name == "fence" for name in names), names)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the watcher uses inotify")
    def test_a_directory_moved_into_one_that_is_away_goes_with_it(self) -> None:
        watcher = self.watcher()
        root = self.scratch / "root"
        outside = self.scratch / "elsewhere"
        (root / "other" / "deep").mkdir(parents=True)
        watcher.read_events()
        self.assertIn(root / "other" / "deep", watcher.watched().values())
        os.rename(root / "old", outside)
        watcher.read_events()
        os.rename(root / "other", outside / "other")
        watcher.read_events()
        self.now += self.guest.MOVE_PAIR_SECONDS
        watcher.read_events()
        self.assertIsNone(watcher.settle_seconds())
        self.assertEqual(list(watcher.watched().values()), [root])
        (outside / "other" / "deep" / "ignored").touch()
        (root / "fence").touch()
        names = [event["name"] for event in watcher.read_events()]
        self.assertTrue(names)
        self.assertTrue(all(name == "fence" for name in names), names)


if __name__ == "__main__":
    unittest.main()
