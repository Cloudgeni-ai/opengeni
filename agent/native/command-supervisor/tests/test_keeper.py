"""Root namespace/static artifact tests; no provider, DB or guest bootstrap."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.dont_write_bytecode = True
BUILD = Path(sys.argv.pop(1))
STATIC = BUILD / "opengeni-command-supervisor"
saved = sys.argv[:]
sys.argv = ["native", str(BUILD)]
spec = importlib.util.spec_from_file_location("native_test", Path(__file__).with_name("test_supervisor.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
sys.argv = saved


class KeeperTests(unittest.TestCase):
    def setUp(self):
        if os.getuid() != 0:
            self.skipTest("Keeper tests require a task-owned UID0 namespace")
        self.directory = "/.c" + os.urandom(32).hex()
        self.path = Path("/.h" + os.urandom(32).hex())
        self.path.write_bytes(STATIC.read_bytes())
        self.path.chmod(0o555)
        self.raw = self.path.read_bytes()
        self.sha = hashlib.sha256(self.raw).hexdigest()
        self.processes = []

    def tearDown(self):
        for process in reversed(self.processes):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
        self.path.unlink(missing_ok=True)
        marker = Path(self.directory) / ".keeper"
        marker.unlink(missing_ok=True)
        if Path(self.directory).exists():
            # Only the exact task-owned empty control directory may be removed.
            Path(self.directory).rmdir()

    def keeper_args(self, *, sha=None, directory=None):
        return [str(self.path), "keeper", "--source-sha", "a" * 40,
                "--artifact-sha256", sha or self.sha, "--control-dir", directory or self.directory]

    def start(self, *, sha=None):
        process = subprocess.Popen(self.keeper_args(sha=sha), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        self.assertTrue(select.select([process.stdout], [], [], 3)[0], "keeper emitted no bounded boot facts")
        line = process.stdout.readline()
        if not line:
            self.fail(process.stderr.read().decode())
        facts = json.loads(line)
        self.assertEqual(facts["protocol"], "native-artifact-keeper-v1")
        self.assertEqual(facts["keeperPid"], process.pid)
        self.assertEqual(facts["state"], "idle")
        self.assertEqual(facts["sourceSha"], "a" * 40)
        self.assertEqual(facts["seals"], 15)
        self.assertEqual(facts["byteSize"], len(self.raw))
        self.assertEqual(facts["controlDirectory"], self.directory)
        self.assertEqual(facts["artifactPath"], f"/proc/{process.pid}/fd/{facts['artifactFd']}")
        self.assertEqual(Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().strip(), "")
        return process, facts

    def execute(self, facts, *arguments, success=True):
        result = subprocess.run([facts["artifactPath"], *arguments], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0 if success else 125, result.stderr.decode())
        return result

    def test_seals_actual_bytes_and_reconnect_survive_original_path_replacement(self):
        process, facts = self.start()
        before = json.loads(self.execute(facts, "artifact-capabilities").stdout)
        self.assertEqual(before["device"], facts["device"])
        self.assertEqual(before["inode"], facts["inode"])
        payload = base64.b64decode(self.execute(facts, "artifact-bytes", "--base64").stdout, validate=True)
        self.assertEqual(payload, self.raw)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), self.sha)
        self.assertEqual(self.execute(facts, "capabilities").stdout, b"native-subreaper-v1")
        replacement = Path(str(self.path) + ".replacement")
        replacement.write_bytes(b"mutable guest replacement")
        os.replace(replacement, self.path)
        fd = os.open(facts["artifactPath"], os.O_RDONLY | os.O_CLOEXEC)
        try:
            self.assertEqual(fcntl.fcntl(fd, fcntl.F_GET_SEALS), 15)
            with self.assertRaises(OSError):
                fcntl.fcntl(fd, fcntl.F_ADD_SEALS, 32)
        finally:
            os.close(fd)
        fd = os.open(facts["artifactPath"], os.O_WRONLY | os.O_CLOEXEC)
        try:
            with self.assertRaises(OSError):
                os.write(fd, b"!")
        finally:
            os.close(fd)
        for number in [signal.SIGINT, signal.SIGHUP]:
            os.kill(process.pid, number)
        time.sleep(0.05)
        self.assertIsNone(process.poll())
        self.assertEqual(before, json.loads(self.execute(facts, "artifact-capabilities").stdout))
        self.assertEqual(self.execute(facts, "artifact-bytes", "--base64").stdout,
                         base64.b64encode(self.raw))
        process.terminate()
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertFalse(Path(self.directory).exists())
        self.assertFalse(Path(facts["artifactPath"]).exists())

    def test_declared_hash_never_substitutes_for_actual_sealed_bytes(self):
        process, facts = self.start(sha="0" * 64)
        self.assertEqual(facts["artifactSha256"], "0" * 64)
        measured = base64.b64decode(self.execute(facts, "artifact-bytes", "--base64").stdout)
        self.assertEqual(hashlib.sha256(measured).hexdigest(), self.sha)
        self.assertNotEqual(hashlib.sha256(measured).hexdigest(), facts["artifactSha256"])
        process.terminate()
        self.assertEqual(process.wait(timeout=3), 0)

    def test_exclusive_root_directory_and_rejected_symlink_have_no_boot_facts(self):
        with tempfile.TemporaryDirectory() as temporary:
            for kind in ["directory", "symlink", "file"]:
                root = Path(self.directory)
                if kind == "directory": root.mkdir(mode=0o700)
                elif kind == "symlink": root.symlink_to(temporary)
                else: root.write_text("unchanged sentinel")
                result = subprocess.run(self.keeper_args(), capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 125)
                self.assertEqual(result.stdout, b"")
                self.assertFalse((Path(temporary) / ".keeper").exists())
                if kind == "directory": root.rmdir()
                else: root.unlink()
            result = subprocess.run(self.keeper_args(directory="/workspace/.c" + "a" * 64),
                                    capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, b"")

    def test_unsealed_filesystem_entry_cannot_claim_artifact_capability(self):
        for arguments in [["artifact-capabilities"], ["artifact-bytes", "--base64"]]:
            result = subprocess.run([str(self.path), *arguments], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, b"")

    def test_nonroot_keeper_rejects_before_directory_creation(self):
        result = subprocess.run(self.keeper_args(), capture_output=True, timeout=3, user=65534)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"")
        self.assertFalse(Path(self.directory).exists())

    def test_memfd_and_sealing_denial_fail_before_boot_or_user_setup(self):
        for mode in ["deny-memfd", "deny-memfd-exec", "deny-seals"]:
            result = subprocess.run([str(BUILD / "fixture"), mode, *self.keeper_args()],
                                    capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, b"")
            self.assertFalse(Path(self.directory).exists())

    def test_long_root_socket_and_real_pty_launch_control_use_original_fd(self):
        keeper, facts = self.start()
        invocation = str(uuid.uuid4())
        path = self.directory + "/" + invocation + ".s"
        self.assertEqual(len(path), 106)
        flags = ["--invocation", invocation, "--nonce", "b" * 64, "--socket", path, "--pty"]
        owner = native.PtyProcess([facts["artifactPath"], "launch", *flags, "--",
                                   "/bin/bash", "--noprofile", "--norc", "-i"])
        deadline = time.monotonic() + 3
        while not Path(path).exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        try:
            self.assertTrue(Path(path).exists())
            def control(action, receipt=None):
                args = ["control", *flags, "--action", action]
                if receipt: args += ["--receipt", receipt]
                return json.loads(self.execute(facts, *args).stdout)
            self.assertEqual(control("status"), {"state":"idle"})
            control("release")
            owner.read_until(b"NATIVE_PROMPT> ")
            owner.send("printf KEEPER_FD_PTY\\n\n")
            self.assertNotIn(b"no job control", owner.read_until(b"NATIVE_PROMPT> "))
            control("cancel")
            response = None
            while time.monotonic() < deadline + 4:
                response = control("status")
                if response["state"] == "quiescent": break
                time.sleep(0.01)
            self.assertEqual(response["state"], "quiescent")
            self.assertEqual(response["receipt"]["protocol"], "native-subreaper-pty-v1")
            self.assertEqual(response, control("status"))
            self.assertEqual(response, control("ack", response["receipt"]["receiptId"]))
            self.assertEqual(owner.wait(timeout=3), 0)
            self.assertIsNone(keeper.poll())
            self.assertEqual(Path(f"/proc/{keeper.pid}/task/{keeper.pid}/children").read_text().strip(), "")
        finally:
            if owner.poll() is None: owner.kill()
            owner.wait(timeout=3)
            owner.close()
            if Path(path).exists(): Path(path).unlink()
        keeper.terminate()
        self.assertEqual(keeper.wait(timeout=3), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
