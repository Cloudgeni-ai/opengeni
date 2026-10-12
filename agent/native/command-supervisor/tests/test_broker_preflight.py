"""Explicit broker bootstrap probe; not native command/provider admission."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

BUILD = Path(sys.argv.pop(1))
BINARY = BUILD / "opengeni-command-supervisor"
FIXTURE = BUILD / "fixture"


class BrokerPreflightTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.getuid(), 0, "preflight requires an owned UID0 test namespace")
        self.identity = str(uuid.uuid4())
        self.arguments = [str(BINARY), "broker-preflight", "--broker-id", self.identity]

    def run_probe(self, prefix=(), **kwargs):
        return subprocess.run([*prefix, *self.arguments], capture_output=True, timeout=25, **kwargs)

    def verify(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b"")
        self.assertTrue(result.stdout.endswith(b"\n"))
        frames = []
        for sequence, line in enumerate(result.stdout.splitlines(), 1):
            self.assertLessEqual(len(line) + 1, 12 * 1024)
            fields = line.decode("ascii").split("\t")
            self.assertEqual(len(fields), 12)
            version, direction, identity, epoch, number, request, command, kind, offset, size, encoding, body = fields
            self.assertEqual((version, direction, identity, epoch), ("OGB1", "response", self.identity, "1"))
            self.assertEqual((int(number), request, command, encoding), (sequence, self.identity, "-", "base64"))
            payload = base64.b64decode(body, validate=True)
            self.assertEqual(base64.b64encode(payload).decode(), body)
            self.assertEqual(len(payload), int(size))
            self.assertLessEqual(int(size), 8192)
            frames.append((kind, int(offset), payload))
        self.assertEqual(frames[0][0:2], ("hello", 0))
        hello = json.loads(frames[0][2])
        self.assertEqual(hello["protocol"], "native-command-broker-preflight-v1")
        self.assertEqual(hello["state"], "preflight_only")
        self.assertEqual(hello["sealedExec"], "execveat")
        self.assertEqual(hello["pipeCapability"], "native-subreaper-v1")
        self.assertEqual(hello["ptyCapability"], "native-subreaper-pty-v1")
        self.assertEqual(hello["artifact"]["seals"], 15)
        self.assertTrue(hello["artifact"]["static"])
        reconstructed = bytearray()
        for kind, offset, payload in frames[1:-1]:
            self.assertEqual(kind, "artifact")
            self.assertEqual(offset, len(reconstructed))
            reconstructed.extend(payload)
        original = BINARY.read_bytes()
        self.assertEqual(bytes(reconstructed), original)
        self.assertEqual(hashlib.sha256(reconstructed).hexdigest(), hashlib.sha256(original).hexdigest())
        self.assertEqual(hello["artifact"]["byteSize"], len(original))
        self.assertEqual(frames[-1][0:2], ("exit", 0))
        self.assertEqual(json.loads(frames[-1][2]), {"preflightComplete": True, "commandAdmission": False})
        return result.stdout

    def test_own_sealed_exec_pipe_and_real_pty_with_exact_artifact_frames(self):
        self.verify(self.run_probe())

    def test_inherited_ignored_sigchld_and_blocked_signals_are_not_false_success(self):
        self.verify(self.run_probe([str(FIXTURE), "sigchld-inherit"]))

    def test_exec_and_kernel_denials_emit_no_success_or_partial_artifact(self):
        for mode in ["deny-execveat", "deny-pidfd", "deny-memfd", "deny-memfd-exec", "deny-seals", "deny-tty"]:
            with self.subTest(mode=mode):
                result = self.run_probe([str(FIXTURE), mode])
                self.assertEqual(result.returncode, 125, result.stderr.decode())
                self.assertEqual(result.stdout, b"")

    def test_nonroot_refuses_without_frames(self):
        result = self.run_probe([str(FIXTURE), "run-unprivileged"])
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"")

    def test_closed_identity_and_options(self):
        cases = [
            ["broker-preflight"],
            ["broker-preflight", "--broker-id", "00000000-0000-0000-0000-000000000000"],
            ["broker-preflight", "--broker-id", self.identity.upper()],
            ["broker-preflight", "--broker-id", self.identity, "--", "/bin/echo", "NOT_PERMITTED"],
            ["broker-preflight", "--broker-id", self.identity + "\n"],
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = subprocess.run([str(BINARY), *arguments], capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 125)
                self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
