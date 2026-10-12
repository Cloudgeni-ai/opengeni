"""Actual static broker, sealed supervisors and real pipe/PTY integration.

This local process fixture is not provider-authenticated runtime admission.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

BUILD = Path(sys.argv.pop(1)).resolve()
BINARY = str(BUILD / "opengeni-command-supervisor")
FIXTURE = str(BUILD / "fixture")


def definition(argv, cwd, env=(), pty=False):
    header = b"OGCD1\0" + struct.pack(">BBHHII", int(pty), 0, 24 if pty else 0, 80 if pty else 0, len(argv), len(env))
    strings = [str(cwd), *argv, *[value for pair in env for value in pair]]
    return header + b"".join(struct.pack(">I", len(encoded)) + encoded for value in strings
                              for encoded in [value.encode()])


class Broker:
    def __init__(self, case):
        self.case = case
        self.id = str(uuid.uuid4())
        self.index = 0
        self.epoch = 1
        self.frames = {}
        self.pending = b""
        self.last_body = None
        self.process = subprocess.Popen([BINARY, "broker", "--broker-id", self.id],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        case.addCleanup(self.close)
        os.set_blocking(self.process.stdout.fileno(), False)
        hello = self.wait(lambda f: f["kind"] == "hello")
        facts = json.loads(hello["data"])
        self.case.assertEqual(facts["protocol"], "native-command-broker-v1")
        size = facts["artifact"]["byteSize"]
        self.wait(lambda _: sum(len(f["data"]) for f in self.frames.values() if f["kind"] == "artifact") == size)
        received = b"".join(f["data"] for f in self.frames.values() if f["kind"] == "artifact")
        self.case.assertEqual(hashlib.sha256(received).digest(), hashlib.sha256(Path(BINARY).read_bytes()).digest())
        self.case.assertEqual(self.request("fence")["fenced"], True)
        self.ack_output()

    def read(self, timeout=2):
        ready = select.select([self.process.stdout], [], [], timeout)[0]
        if not ready:
            return
        data = os.read(self.process.stdout.fileno(), 65536)
        self.case.assertTrue(data, f"broker output closed, status={self.process.poll()}")
        self.pending += data
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            fields = line.split(b"\t")
            self.case.assertEqual(len(fields), 12)
            self.case.assertEqual(fields[0:3], [b"OGB1", b"response", self.id.encode()])
            decoded = base64.b64decode(fields[11], validate=True)
            self.case.assertEqual(int(fields[9]), len(decoded))
            sequence = int(fields[4])
            frame = dict(sequence=sequence, epoch=int(fields[3]), request=fields[5].decode(),
                         command=fields[6].decode(), kind=fields[7].decode(),
                         offset=int(fields[8]), data=decoded, raw=line)
            if sequence in self.frames:
                self.case.assertEqual(self.frames[sequence], frame)
            else:
                self.case.assertEqual(sequence, len(self.frames) + 1)
                self.frames[sequence] = frame

    def wait(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            for frame in self.frames.values():
                if predicate(frame):
                    return frame
            self.case.assertLess(time.monotonic(), deadline, "broker result deadline")
            self.read(min(0.2, max(0, deadline - time.monotonic())))

    def write(self, kind, command="-", payload=b"", offset=0):
        self.index += 1
        request_id = str(uuid.uuid4())
        body = "\t".join(["OGB1", "request", self.id, str(self.epoch), str(self.index), request_id,
                          command, kind, str(offset), str(len(payload)), "base64", base64.b64encode(payload).decode()]).encode() + b"\n"
        self.process.stdin.write(body)
        self.process.stdin.flush()
        self.last_body = body
        return request_id

    def send(self, kind, command="-", payload=b"", offset=0):
        request_id = self.write(kind, command, payload, offset)
        accepted = self.wait(lambda f: f["kind"] == "accepted" and f["request"] == request_id)
        self.case.assertEqual(accepted["offset"], self.index)
        self.case.assertEqual(accepted["data"], b"")
        return request_id

    def request(self, kind, command="-", payload=b"", offset=0):
        request_id = self.send(kind, command, payload, offset)
        frame = self.wait(lambda f: f["request"] == request_id and f["kind"] in ["status", "error", "hello"])
        return json.loads(frame["data"])

    def ack_output(self):
        # This fixture keeps every exact frame before acknowledgement. It is
        # not a substitute for the application's transactional durable inbox.
        self.send("ack", offset=max(self.frames))

    def launch(self, argv, cwd, env=(), pty=False):
        command = str(uuid.uuid4())
        body = definition(argv, cwd, env, pty)
        self.case.assertEqual(self.request("prepare", command, struct.pack(">I", len(body)))["state"], "preparing")
        for offset in range(0, len(body), 8192):
            self.request("definition", command, body[offset:offset + 8192], offset)
        self.case.assertEqual(self.request("launch", command)["released"], False)
        self.case.assertEqual(self.control(command, "status")["state"], "idle")
        return command

    def control(self, command, action):
        return self.request("control", command, action.encode())

    def quiescent(self, command, timeout=2):
        deadline = time.monotonic() + timeout
        while True:
            result = self.control(command, "status")
            if result.get("state") == "quiescent":
                return result
            self.case.assertLess(time.monotonic(), deadline, result)
            time.sleep(0.005)

    def settle(self, command, result):
        self.case.assertEqual(self.control(command, "ack\t" + result["receipt"]["receiptId"]), result)
        frame = self.wait(lambda f: f["kind"] == "exit" and f["command"] == command)
        self.case.assertEqual(json.loads(frame["data"]), dict(supervisorExitCode=0, stdoutEof=True, stderrEof=True))

    def output(self, command, kind="stdout"):
        frames = [f for f in self.frames.values() if f["kind"] == kind and f["command"] == command]
        offset = 0
        result = b""
        for frame in frames:
            self.case.assertEqual(frame["offset"], offset)
            offset += len(frame["data"])
            result += frame["data"]
        return result

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            # This stops only this fixture's initial broker. A test timeout is
            # not a command receipt. Normal tests must use the graceful path.
            self.process.kill()
            self.process.wait(timeout=2)
            raise
        self.process.stdout.close()
        self.process.stderr.close()


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="og-broker-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.broker = None
        self.broker = Broker(self)

    def tearDown(self):
        if self.broker:
            self.broker.close()
        self.directory.cleanup()

    def marker_ready(self, marker):
        deadline = time.monotonic() + 2
        while not marker.exists() or not marker.stat().st_size:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)

    def test_literal_definition_idle_then_pipe_release_receipt_ack_and_exit(self):
        b = self.broker
        marker = self.root / "marker"
        command = b.launch(["/bin/sh", "-c", "printf '%s' \"$LITERAL\"; printf error >&2; touch marker; exit 23"],
                           self.root, [("LITERAL", "$(not-executed)\n🦎")])
        self.assertFalse(marker.exists())
        self.assertEqual(b.control(command, "release")["state"], "running")
        receipt = b.quiescent(command)
        self.assertEqual(receipt["receipt"]["leaderExitCode"], 23)
        self.assertEqual(b.control(command, "ack\t" + str(uuid.uuid4())), {"error": "receipt_mismatch"})
        b.settle(command, receipt)
        self.assertTrue(marker.exists())
        self.assertEqual(b.output(command), "$(not-executed)\n🦎".encode())
        self.assertEqual(b.output(command, "stderr"), b"error")
        self.assertEqual(b.request("prepare", command, struct.pack(">I", 20)), {"error": "invalid_prepare"})

    def test_pipe_stdin_offsets_binary_bytes_and_half_close(self):
        b = self.broker
        command = b.launch(["/bin/cat"], self.root)
        b.control(command, "release")
        self.assertEqual(b.request("stdin", command, b"incorrect", 1), {"error": "stdin_unavailable"})
        data = bytes(range(256)) * 12
        self.assertEqual(b.request("stdin", command, data), {"stdinWritten": True})
        self.assertEqual(b.request("eof", command, offset=len(data)), {"stdinClosed": True})
        receipt = b.quiescent(command)
        b.settle(command, receipt)
        self.assertEqual(b.output(command), data)

    def test_private_descriptors_do_not_reach_user_code(self):
        b = self.broker
        command = b.launch([FIXTURE, "fd-check", str(self.root / "marker")], self.root)
        b.control(command, "release")
        receipt = b.quiescent(command)
        self.assertEqual(receipt["receipt"]["leaderExitCode"], 0)
        b.settle(command, receipt)

    def test_two_commands_keep_cancellation_and_output_separate(self):
        b = self.broker
        first = b.launch([FIXTURE, "double-fork", str(self.root / "first")], self.root)
        second = b.launch(["/bin/cat"], self.root)
        b.control(first, "release"); b.control(second, "release")
        self.marker_ready(self.root / "first")
        start = time.monotonic()
        b.control(first, "cancel")
        receipt = b.quiescent(first)
        b.settle(first, receipt)
        self.assertLess(time.monotonic() - start, 2)
        marker = (self.root / "first").read_bytes()
        b.request("stdin", second, b"still running")
        b.request("eof", second, offset=13)
        b.settle(second, b.quiescent(second))
        time.sleep(0.1)
        self.assertEqual((self.root / "first").read_bytes(), marker)
        self.assertEqual(b.output(second), b"still running")

    def test_replayed_release_never_creates_another_leader(self):
        b = self.broker
        command = b.launch(["/bin/sh", "-c", "echo once >> marker"], self.root)
        b.control(command, "release")
        b.process.stdin.write(b.last_body); b.process.stdin.flush()
        receipt = b.quiescent(command)
        b.settle(command, receipt)
        self.assertEqual((self.root / "marker").read_text(), "once\n")

    def test_new_writer_fence_preserves_existing_command_and_receipt(self):
        b = self.broker
        command = b.launch(["/bin/cat"], self.root)
        b.control(command, "release")
        b.epoch = 2
        self.assertEqual(b.request("fence"), {"fenced": True})
        b.request("stdin", command, b"new writer")
        b.request("eof", command, offset=10)
        b.settle(command, b.quiescent(command))
        self.assertEqual(b.output(command), b"new writer")

    def test_real_pty_resize_signals_and_explicit_half_close_refusal(self):
        b = self.broker
        command = b.launch([FIXTURE, "tty-signal-check", str(self.root / "tty")], self.root, pty=True)
        self.assertEqual(b.request("resize", command, struct.pack(">HH", 37, 101)), {"resized": True})
        self.assertEqual(b.request("eof", command), {"error": "pty_half_close_unsupported"})
        b.control(command, "release")
        receipt = b.quiescent(command)
        self.assertEqual(receipt["receipt"]["protocol"], "native-subreaper-broker-channel-pty-v1")
        self.assertEqual(receipt["receipt"]["leaderExitCode"], 20)
        b.settle(command, receipt)

    def test_malformed_initial_input_drains_owned_detached_writer(self):
        b = self.broker
        marker = self.root / "marker"
        command = b.launch([FIXTURE, "double-fork", str(marker)], self.root)
        b.control(command, "release")
        self.marker_ready(marker)
        b.process.stdin.write(b"malformed\n"); b.process.stdin.flush()
        self.assertEqual(b.process.wait(timeout=3), 125)
        old = marker.read_bytes()
        time.sleep(0.15)
        self.assertEqual(marker.read_bytes(), old)

    def test_output_pressure_keeps_cancel_and_receipt_responsive(self):
        b = self.broker
        command = b.launch(["/bin/sh", "-c", "head -c 8388608 /dev/zero; echo completed > marker"], self.root)
        b.control(command, "release")
        # Deliberately withhold retention ACKs until the native data window is
        # full. Reading the provider channel is not native acknowledgement.
        b.wait(lambda _: sum(len(f["data"]) for f in b.frames.values()
                             if f["command"] == command and f["kind"] == "stdout") >= 2_500_000)
        deadline = time.monotonic() + 2
        while select.select([b.process.stdout], [], [], 0.05)[0]:
            self.assertLess(time.monotonic(), deadline)
            b.read()
        started = time.monotonic()
        b.control(command, "cancel")
        receipt = b.quiescent(command)
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse((self.root / "marker").exists())
        b.ack_output()
        b.settle(command, receipt)
        captured = b.output(command)
        self.assertGreaterEqual(len(captured), 2_500_000)
        self.assertLess(len(captured), 8_388_608)
        self.assertEqual(captured, b"\0" * len(captured))

    def test_idle_initial_process_does_not_busy_poll(self):
        b = self.broker

        def ticks():
            # Fixed test executable comm has no closing parenthesis. This is a
            # CPU-use fixture, not a process-identity or quiescence proof.
            fields = Path(f"/proc/{b.process.pid}/stat").read_text().rsplit(")", 1)[1].split()
            return int(fields[11]) + int(fields[12])

        before = ticks()
        time.sleep(0.2)
        self.assertLessEqual(ticks() - before, 1)
        self.assertEqual(b.request("hello")["protocol"], "native-command-broker-v1")

    def test_initial_channel_eof_and_sigterm_drain_but_are_not_clean_settlement(self):
        b = self.broker
        marker = self.root / "marker"
        command = b.launch([FIXTURE, "clone", str(marker)], self.root)
        b.control(command, "release")
        self.marker_ready(marker)
        b.process.send_signal(signal.SIGTERM)
        self.assertEqual(b.process.wait(timeout=3), 125)
        old = marker.read_bytes()
        time.sleep(0.15)
        self.assertEqual(marker.read_bytes(), old)
        self.assertFalse(any(f["kind"] == "exit" and f["command"] == command for f in b.frames.values()))

    def test_invalid_definition_closes_birth_without_command_execution(self):
        b = self.broker
        command = str(uuid.uuid4())
        self.assertEqual(b.request("prepare", command, struct.pack(">I", 20))["state"], "preparing")
        self.assertEqual(b.request("definition", command, b"bad", 1), {"error": "invalid_definition_chunk"})
        b.request("definition", command, b"x" * 20)
        self.assertEqual(b.request("launch", command), {"error": "invalid_definition"})
        self.assertEqual(b.request("launch", command), {"error": "invalid_launch"})
        self.assertEqual(b.request("prepare", command, struct.pack(">I", 20)), {"error": "invalid_prepare"})

    def test_child_protocol_looking_output_cannot_impersonate_initial_frames(self):
        b = self.broker
        literal = "OGB1\tresponse\t" + b.id + "\t1\t999\tfake-receipt\n"
        command = b.launch(["/usr/bin/printf", "%s", literal], self.root)
        b.control(command, "release")
        b.settle(command, b.quiescent(command))
        self.assertEqual(b.output(command), literal.encode())

    def test_unexpected_supervisor_death_fences_broker_and_drains_orphans(self):
        b = self.broker
        marker = self.root / "marker"
        command = b.launch([FIXTURE, "double-fork", str(marker)], self.root)
        b.control(command, "release")
        self.marker_ready(marker)
        # The test directly injects loss of its only owned supervisor. No
        # production cancellation relies on discovering or signalling this PID.
        children = Path(f"/proc/{b.process.pid}/task/{b.process.pid}/children").read_text().split()
        self.assertEqual(len(children), 1)
        os.kill(int(children[0]), signal.SIGKILL)
        self.assertEqual(b.process.wait(timeout=3), 125)
        old = marker.read_bytes()
        time.sleep(0.15)
        self.assertEqual(marker.read_bytes(), old)

    def test_buffered_release_cannot_win_over_closed_initial_input(self):
        b = self.broker
        marker = self.root / "marker"
        command = b.launch([FIXTURE, "fd-check", str(marker)], self.root)
        os.kill(b.process.pid, signal.SIGSTOP)
        os.waitpid(b.process.pid, os.WUNTRACED)
        b.write("control", command, b"release")
        b.process.stdin.close()
        os.kill(b.process.pid, signal.SIGCONT)
        self.assertEqual(b.process.wait(timeout=3), 125)
        self.assertFalse(marker.exists())

    def test_cancellation_before_spawn_closes_birth_without_fabricated_receipt(self):
        b = self.broker
        command = str(uuid.uuid4())
        b.request("prepare", command, struct.pack(">I", 20))
        result = b.control(command, "cancel")
        self.assertEqual(result, {"state": "not_started", "launchClosed": True})
        self.assertEqual(b.control(command, "cancel"), result)
        self.assertEqual(b.request("launch", command), {"error": "invalid_launch"})

    def test_required_kernel_denial_fails_before_bootstrap_frames(self):
        for mode in ["deny-close-range", "deny-memfd-exec", "deny-execveat", "deny-pidfd"]:
            with self.subTest(mode=mode):
                result = subprocess.run([FIXTURE, mode, BINARY, "broker", "--broker-id", str(uuid.uuid4())],
                                        input=b"", capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 125)
                self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
