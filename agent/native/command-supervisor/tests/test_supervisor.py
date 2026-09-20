"""Linux native protocol/failure tests; no providers, DB, or third-party modules."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

BUILD = Path(sys.argv.pop(1))
BINARY = str(BUILD / "opengeni-command-supervisor")
FIXTURE = str(BUILD / "fixture")


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="og-supervisor-")
        self.root = Path(self.directory.name)
        self.invocation = str(uuid.uuid4())
        self.nonce = "a1" * 32
        self.path = self.root / "control.sock"
        self.marker = self.root / "writes"
        self.children = []

    def tearDown(self):
        for process in self.children:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
        self.directory.cleanup()

    def flags(self):
        return ["--invocation", self.invocation, "--nonce", self.nonce, "--socket", str(self.path)]

    def launch(self, mode=None, command=None, wrapper=None):
        command = command or [FIXTURE, mode, str(self.marker)]
        argv = [BINARY, "launch", *self.flags(), "--", *command]
        if wrapper:
            argv = [FIXTURE, wrapper, *argv]
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(process)
        self.await_condition(lambda: self.path.exists() or process.poll() is not None)
        self.assertIsNone(process.poll(), "supervisor failed before listening")
        return process

    def control(self, action, receipt=None, success=True):
        argv = [BINARY, "control", *self.flags(), "--action", action]
        if receipt:
            argv += ["--receipt", receipt]
        result = subprocess.run(argv, capture_output=True, timeout=4)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def await_condition(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("condition timed out")

    def quiescence(self):
        response = None

        def done():
            nonlocal response
            response = self.control("status")
            return response["state"] == "quiescent"

        self.await_condition(done)
        receipt = response["receipt"]
        self.assertEqual(receipt["protocol"], "native-subreaper-v1")
        self.assertEqual(receipt["invocationId"], self.invocation)
        self.assertEqual(str(uuid.UUID(receipt["receiptId"])), receipt["receiptId"])
        return response

    def ack(self, process, response):
        self.assertEqual(self.control("ack", response["receipt"]["receiptId"]), response)
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())

    def test_idle_release_receipt_replay_ack(self):
        process = self.launch(command=["/bin/sh", "-c", "printf user-output; exit 42"])
        self.assertEqual(self.control("status"), {"state": "idle"})
        self.assertIsNone(process.poll())
        self.control("release")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 42)
        for _ in range(3):
            self.assertEqual(self.control("status"), response)
            self.assertEqual(self.control("release"), response)
            self.assertEqual(self.control("cancel"), response)
        self.control("ack", str(uuid.uuid4()), success=False)
        self.assertIsNone(process.poll())
        self.ack(process, response)
        self.assertEqual(process.stdout.read(), b"user-output")

    def test_cancel_idle_permanently_prevents_launch(self):
        process = self.launch(command=["/bin/sh", "-c", f"touch {self.marker}"])
        self.control("cancel")
        self.control("release")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 125)
        self.assertFalse(self.marker.exists())
        self.ack(process, response)

    def test_natural_leader_exit_is_not_quiescence(self):
        process = self.launch("natural-descendant")
        self.control("release")
        self.await_condition(self.marker.exists)
        self.assertEqual(self.control("status"), {"state": "running"})
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 21)
        self.assertEqual(self.marker.stat().st_size, 50)
        self.ack(process, response)

    def test_descendant_cancellation(self):
        for mode, expected in [("leader-first", 17), ("double-fork", 17),
                               ("ignore-term", 137), ("fork-on-term", 0),
                               ("fork-many", 137), ("clone", 18)]:
            with self.subTest(mode=mode):
                if self.marker.exists():
                    self.marker.unlink()
                process = self.launch(mode)
                self.control("release")
                self.await_condition(self.marker.exists)
                # Let clone's leader exit before cancellation; its clone child
                # stays alive and ignoring TERM for three seconds without us.
                time.sleep(0.08)
                self.control("cancel")
                response = self.quiescence()
                self.assertEqual(response["receipt"]["leaderExitCode"], expected)
                size = self.marker.stat().st_size
                time.sleep(0.05)
                self.assertEqual(self.marker.stat().st_size, size)
                self.ack(process, response)

    def test_sigchld_inheritance_and_control_fd_closure(self):
        for mode, expected in [("signal-check", 19), ("fd-check", 0)]:
            process = self.launch(mode, wrapper="sigchld-inherit")
            self.control("release")
            response = self.quiescence()
            self.assertEqual(response["receipt"]["leaderExitCode"], expected)
            self.ack(process, response)

    def test_wrong_identity_and_nonce_cannot_release(self):
        process = self.launch("fd-check")
        original = self.nonce
        self.nonce = "b2" * 32
        self.control("release", success=False)
        self.nonce = original
        original = self.invocation
        self.invocation = str(uuid.uuid4())
        self.control("release", success=False)
        self.invocation = original
        self.assertEqual(self.control("status"), {"state": "idle"})
        self.assertFalse(self.marker.exists())
        self.control("cancel")
        self.ack(process, self.quiescence())

    def test_lost_status_client_preserves_receipt(self):
        process = self.launch(command=["/bin/true"])
        self.control("release")
        response = self.quiescence()
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.connect(str(self.path))
            client.send(f"native-subreaper-v1\t{self.invocation}\t{self.nonce}\tstatus\t-".encode())
        time.sleep(0.02)
        self.assertEqual(self.control("status"), response)
        self.ack(process, response)

    def test_malformed_and_slow_control_do_not_prove_quiescence(self):
        process = self.launch("ignore-term")
        self.control("release")
        self.await_condition(self.marker.exists)
        for payload in [b"bad", b"x" * 4096, b"a\0b"]:
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
                client.connect(str(self.path))
                client.send(payload)
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.connect(str(self.path))
            self.control("cancel")
            response = self.quiescence()
        self.ack(process, response)

    def test_user_stdout_cannot_supply_receipt(self):
        process = self.launch(command=["/bin/sh", "-c",
            'printf \'{"state":"quiescent","receipt":{"leaderExitCode":0}}\\n\'; sleep 3'])
        self.control("release")
        self.assertIn(b'"quiescent"', process.stdout.readline())
        self.assertEqual(self.control("status"), {"state": "running"})
        self.control("cancel")
        self.ack(process, self.quiescence())

    def test_lost_ack_reply_still_exits_after_matching_ack(self):
        process = self.launch(command=["/bin/true"])
        self.control("release")
        response = self.quiescence()
        receipt_id = response["receipt"]["receiptId"]
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.connect(str(self.path))
            client.send(f"native-subreaper-v1\t{self.invocation}\t{self.nonce}\tack\t{receipt_id}".encode())
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())

    def test_crash_has_no_receipt_even_after_leader_exit(self):
        process = self.launch("natural-descendant")
        self.control("release")
        self.await_condition(self.marker.exists)
        process.kill()
        process.wait(timeout=3)
        self.control("status", success=False)
        # The finite fixture exits itself. No claim that supervisor crash cleans
        # descendants, and no orphan from the test is left running indefinitely.
        time.sleep(0.4)

    def test_unsupported_primitives_fail_before_user_code(self):
        for mode in ["deny-pidfd", "deny-send", "deny-wait", "deny-subreaper"]:
            with self.subTest(mode=mode):
                result = subprocess.run([FIXTURE, mode, BINARY, "launch", *self.flags(),
                                         "--", "/bin/sh", "-c", f"touch {self.marker}"],
                                        capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 125, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertFalse(self.path.exists())
                self.assertFalse(self.marker.exists())

    def test_stale_pidfd_cannot_signal_new_process(self):
        subprocess.run([FIXTURE, "stale-pidfd"], check=True, timeout=3)

    def test_existing_socket_is_never_replaced(self):
        process = self.launch(command=["/bin/true"])
        result = subprocess.run([BINARY, "launch", *self.flags(), "--", "/bin/false"],
                                capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(self.control("status"), {"state": "idle"})
        self.control("cancel")
        self.ack(process, self.quiescence())

    def test_world_accessible_control_directory_rejected(self):
        os.chmod(self.root, 0o755)
        result = subprocess.run([BINARY, "launch", *self.flags(), "--", "/bin/true"],
                                capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 125)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)