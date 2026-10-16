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
            env={**os.environ, "SMOKE_GUEST_STATE": str(cls.scratch / "state")},
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
        for line in (b"restored\n", b"restored soon\n", b"hello 1\n", b""):
            with self.subTest(line=line):
                self.assertEqual(self.notice(line), b"")
        self.assertEqual(self.ok({"op": "ping"})["restores"], before)

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


def _load_guest(state: Path) -> Any:
    """Imports the guest service as a module, keeping its files in `state`."""

    with mock.patch.dict(os.environ, {"SMOKE_GUEST_STATE": str(state)}):
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

    def test_signalling_an_exited_process_leaves_its_old_group_alone(self) -> None:
        process = self.guest.PROCESSES.start("true", dict(os.environ), None)
        self.addCleanup(self.guest.PROCESSES.forget, process.pid)
        self.assertTrue(process.exited.wait(10))
        with mock.patch.object(self.guest.os, "killpg") as killpg:
            reply = self.guest.op_signal({"pid": process.pid, "signal": signal.SIGTERM})
        self.assertEqual(reply, {"delivered": False})
        killpg.assert_not_called()

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


if __name__ == "__main__":
    unittest.main()
