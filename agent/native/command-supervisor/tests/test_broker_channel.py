"""Private inherited supervisor-channel tests; no broker admission is claimed."""
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile
import time
import unittest
import uuid

# Reuse the actual inherited-terminal fixture. Importing consumes the build arg;
# the module's test class is not imported into this module's discovery namespace.
import test_supervisor as native


class BrokerChannelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="og-broker-channel-")
        self.marker = Path(self.directory.name) / "writes"
        self.invocation = str(uuid.uuid4())
        self.nonce = "ca" * 32
        self.processes = []
        self.channels = []
        self.protocol = "native-subreaper-broker-channel-v1"

    def tearDown(self):
        # Closing only this test's channels asks their supervisors to drain.
        for channel in self.channels:
            channel.close()
        for process in self.processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
            if isinstance(process, native.PtyProcess):
                process.close()
        self.directory.cleanup()

    def argv(self, fd, command, pty=False):
        return [native.BINARY, "launch-channel", "--control-fd", str(fd),
                "--invocation", self.invocation, "--nonce", self.nonce,
                *(["--pty"] if pty else []), "--", *command]

    def launch(self, mode="fd-check", command=None, pty=False, wrapper=None):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.channels.append(parent)
        parent.settimeout(2)
        command = command or [native.FIXTURE, mode, str(self.marker)]
        argv = self.argv(child.fileno(), command, pty=pty)
        if wrapper:
            argv = [native.FIXTURE, wrapper, *argv]
        if pty:
            self.protocol = "native-subreaper-broker-channel-pty-v1"
            process = native.PtyProcess(argv, pass_fds=[child.fileno()])
        else:
            process = subprocess.Popen(argv, pass_fds=[child.fileno()],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.close()
        self.processes.append(process)
        return process, parent

    def frame(self, action, receipt="-", nonce=None, protocol=None):
        return "\t".join([protocol or self.protocol, self.invocation,
                          nonce or self.nonce, action, receipt]).encode()

    def request(self, channel, action, receipt="-", **kwargs):
        channel.send(self.frame(action, receipt, **kwargs))
        return json.loads(channel.recv(1024))

    def quiescent(self, channel, timeout=2):
        deadline = time.monotonic() + timeout
        while True:
            response = self.request(channel, "status")
            if response["state"] == "quiescent":
                return response
            self.assertLess(time.monotonic(), deadline, response)
            time.sleep(0.01)

    def wait_for_writes(self):
        deadline = time.monotonic() + 2
        while not self.marker.exists() or not self.marker.stat().st_size:
            self.assertLess(time.monotonic(), deadline, "fixture never ran")
            time.sleep(0.01)

    def unchanged(self):
        before = self.marker.read_bytes() if self.marker.exists() else b""
        time.sleep(0.15)
        self.assertEqual(self.marker.read_bytes() if self.marker.exists() else b"", before)

    def ack(self, process, channel, response):
        self.assertEqual(self.request(channel, "ack", response["receipt"]["receiptId"]), response)
        self.assertEqual(process.wait(timeout=2), 0)

    def test_idle_release_exact_receipt_and_replay(self):
        process, channel = self.launch(command=["/bin/sh", "-c", "printf payload; exit 23"])
        self.assertEqual(self.request(channel, "status"), {"state": "idle"})
        self.assertFalse(select.select([process.stdout], [], [], 0.05)[0])
        self.assertEqual(self.request(channel, "release"), {"state": "running"})
        response = self.quiescent(channel)
        self.assertEqual(response["receipt"]["protocol"], self.protocol)
        self.assertEqual(response["receipt"]["invocationId"], self.invocation)
        self.assertEqual(response["receipt"]["leaderExitCode"], 23)
        self.assertEqual(self.request(channel, "release"), response)
        self.assertEqual(self.request(channel, "cancel"), response)
        self.assertEqual(self.request(channel, "ack", str(uuid.uuid4())),
                         {"error": "receipt_mismatch"})
        self.ack(process, channel, response)
        self.assertEqual(process.stdout.read(), b"payload")
        self.assertEqual(process.stderr.read(), b"")

    def test_invalid_frames_never_release(self):
        process, channel = self.launch(mode="ignore-term")
        for data in [b"incomplete", b"x" * 4096, self.frame("release") + b"\x00tail",
                     self.frame("release") + b"\textra"]:
            channel.send(data)
            self.assertEqual(json.loads(channel.recv(1024)), {"error": "unauthenticated"})
        for kwargs in [{"nonce": "ab" * 32}, {"protocol": "native-subreaper-v1"}]:
            self.assertEqual(self.request(channel, "release", **kwargs),
                             {"error": "unauthenticated"})
        self.assertEqual(self.request(channel, "other"), {"error": "invalid_action"})
        self.assertEqual(self.request(channel, "release", "not-dash"), {"error": "invalid_action"})
        self.assertEqual(self.request(channel, "status"), {"state": "idle"})
        self.assertFalse(self.marker.exists())
        self.request(channel, "cancel")
        response = self.quiescent(channel)
        self.assertEqual(response["receipt"]["leaderExitCode"], 125)
        self.ack(process, channel, response)

    def test_channel_close_before_release_never_runs_user_code(self):
        process, channel = self.launch(mode="ignore-term")
        self.assertEqual(self.request(channel, "status"), {"state": "idle"})
        channel.close()
        self.assertEqual(process.wait(timeout=2), 125)
        self.assertFalse(self.marker.exists())
        self.assertEqual(process.stdout.read(), b"")

    def test_queued_release_on_closed_peer_does_not_launch(self):
        process, channel = self.launch(mode="ignore-term")
        # Stop the supervisor before enqueueing: HUP wins over buffered release.
        self.assertEqual(self.request(channel, "status"), {"state": "idle"})
        os.kill(process.pid, native.signal.SIGSTOP)
        os.waitpid(process.pid, os.WUNTRACED)
        channel.send(self.frame("release"))
        channel.close()
        os.kill(process.pid, native.signal.SIGCONT)
        self.assertEqual(process.wait(timeout=2), 125)
        self.assertFalse(self.marker.exists())

    def test_input_half_close_fails_closed(self):
        process, channel = self.launch(mode="ignore-term")
        # A zero-byte send is a no-op on some supported kernels. Use an actual
        # half-close to establish receive EOF, rather than infer delivery from 0.
        channel.send(b"")
        channel.shutdown(socket.SHUT_WR)
        self.assertEqual(process.wait(timeout=2), 125)
        self.assertFalse(self.marker.exists())

    def test_close_drains_detached_term_ignoring_descendants(self):
        for mode in ["double-fork", "ignore-term", "fork-on-term", "clone"]:
            with self.subTest(mode=mode):
                self.marker.unlink(missing_ok=True)
                process, channel = self.launch(mode=mode)
                self.request(channel, "release")
                self.wait_for_writes()
                started = time.monotonic()
                channel.close()
                self.assertEqual(process.wait(timeout=2), 125)
                self.assertLess(time.monotonic() - started, 2)
                self.unchanged()
                self.assertEqual(process.stdout.read(), b"")

    def test_cancel_remains_usable_on_persistent_channel(self):
        process, channel = self.launch(mode="fork-many")
        self.request(channel, "release")
        self.wait_for_writes()
        started = time.monotonic()
        self.request(channel, "cancel")
        response = self.quiescent(channel)
        self.assertLess(time.monotonic() - started, 2)
        self.unchanged()
        self.ack(process, channel, response)

    def test_closed_after_receipt_is_not_clean_ack(self):
        process, channel = self.launch()
        self.request(channel, "release")
        self.quiescent(channel)
        channel.close()
        self.assertEqual(process.wait(timeout=2), 125)

    def test_no_control_descriptors_or_signal_mask_in_user_child(self):
        for mode, expected in [("fd-check", 0), ("signal-check", 19)]:
            with self.subTest(mode=mode):
                process, channel = self.launch(mode=mode, wrapper="sigchld-inherit")
                self.request(channel, "release")
                response = self.quiescent(channel)
                self.assertEqual(response["receipt"]["leaderExitCode"], expected)
                self.ack(process, channel, response)

    def test_blocked_response_channel_cancels_instead_of_blocking(self):
        process, channel = self.launch(mode="ignore-term")
        self.request(channel, "release")
        self.wait_for_writes()
        channel.setblocking(False)
        deadline = time.monotonic() + 2
        while process.poll() is None and time.monotonic() < deadline:
            try:
                channel.send(self.frame("status"))
            except BlockingIOError:
                time.sleep(0.001)
            except (BrokenPipeError, ConnectionResetError):
                break
        self.assertEqual(process.wait(timeout=2), 125)
        self.unchanged()

    def test_real_pty_signal_fd_and_receipt_semantics(self):
        for mode, code in [("fd-check", 0), ("tty-signal-check", 20)]:
            with self.subTest(mode=mode):
                process, channel = self.launch(mode=mode, pty=True)
                self.request(channel, "release")
                response = self.quiescent(channel)
                self.assertEqual(response["receipt"]["protocol"], self.protocol)
                self.assertEqual(response["receipt"]["leaderExitCode"], code)
                self.ack(process, channel, response)

    def test_real_pty_job_control_and_channel_loss(self):
        process, channel = self.launch(pty=True, command=["/bin/bash", "--noprofile", "--norc", "-i"])
        self.request(channel, "release")
        output = process.read_until(b"NATIVE_PROMPT> ")
        self.assertNotIn(b"no job control", output)
        process.send("sleep 10\n")
        time.sleep(0.05)
        process.send(b"\x1a")
        self.assertIn(b"Stopped", process.read_until(b"NATIVE_PROMPT> "))
        process.send("fg\n")
        time.sleep(0.05)
        process.send(b"\x03")
        process.read_until(b"NATIVE_PROMPT> ")
        process.send("printf STILL_INTERACTIVE\n\n")
        process.read_until(b"STILL_INTERACTIVE")
        channel.close()
        self.assertEqual(process.wait(timeout=2), 125)

    def test_pipe_cannot_claim_pty_mode(self):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.channels.extend([parent, child])
        result = subprocess.run(self.argv(child.fileno(), ["/bin/true"], pty=True),
                                pass_fds=[child.fileno()], capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 125)

    def test_rejects_invalid_descriptor_options(self):
        for value in ["0", "1", "2", "03", "-1", "+3", "3x", " 3", "2147483648", "9" * 64]:
            with self.subTest(value=value):
                result = subprocess.run(self.argv(value, ["/bin/true"]), capture_output=True, timeout=2)
                self.assertEqual(result.returncode, 125)
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.channels.extend([parent, child])
        base = self.argv(child.fileno(), ["/bin/true"])
        for extra in [["--socket", str(self.marker)], ["--control-fd", str(child.fileno())]]:
            argv = base[:2] + extra + base[2:]
            result = subprocess.run(argv, pass_fds=[child.fileno()], capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 125)

    def test_rejects_pipe_stream_unconnected_and_named_sockets(self):
        read_fd, write_fd = os.pipe()
        stream_a, stream_b = socket.socketpair()
        unconnected = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        listener.bind(str(Path(self.directory.name) / "named.sock"))
        listener.listen(1)
        connected = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        connected.connect(listener.getsockname())
        accepted, _ = listener.accept()
        self.channels.extend([stream_a, stream_b, unconnected, listener, connected, accepted])
        try:
            for fd in [read_fd, stream_a.fileno(), unconnected.fileno(), connected.fileno(), accepted.fileno()]:
                with self.subTest(fd=fd):
                    result = subprocess.run(self.argv(fd, ["/bin/true"]), pass_fds=[fd],
                                            capture_output=True, timeout=2)
                    self.assertEqual(result.returncode, 125)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_socketpair_created_by_other_process_is_rejected(self):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        pid = os.fork()
        if pid == 0:
            parent.close()
            a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            socket.send_fds(child, [b"pair"], [a.fileno(), b.fileno()])
            os._exit(0)
        child.close()
        try:
            _, fds, _, _ = socket.recv_fds(parent, 16, 2)
            self.assertEqual(len(fds), 2)
            try:
                result = subprocess.run(self.argv(fds[0], ["/bin/true"]), pass_fds=[fds[0]],
                                        capture_output=True, timeout=2)
                self.assertEqual(result.returncode, 125)
                self.assertIn(b"parent identity unavailable", result.stderr)
            finally:
                for fd in fds:
                    os.close(fd)
        finally:
            parent.close()
            os.waitpid(pid, 0)


if __name__ == "__main__":
    unittest.main()
