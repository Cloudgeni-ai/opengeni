"""The reference guest service's protocol, exercised over a Unix socket on
the host instead of vsock inside a VM."""

from __future__ import annotations

import base64
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
        cls.service = subprocess.Popen(
            [sys.executable, str(GUEST), "--listen", f"unix:{cls.address}"],
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


if __name__ == "__main__":
    unittest.main()
