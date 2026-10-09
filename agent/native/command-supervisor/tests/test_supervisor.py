"""Linux native protocol/failure tests; no providers, DB, or third-party modules."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import fcntl
import struct
import termios

BUILD = Path(sys.argv.pop(1))
BINARY = str(BUILD / "opengeni-command-supervisor")
FIXTURE = str(BUILD / "fixture")
KERNEL = str(BUILD / "kernel")


class PtyProcess:
    """forkpty gives the exact inherited provider topology, not a pipe imitation."""
    stdout = None
    stderr = None

    def __init__(self, argv, redirected=False):
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            os.environ["PS1"] = "NATIVE_PROMPT> "
            os.environ["TERM"] = "dumb"
            if redirected:
                fd = os.open("/dev/null", os.O_WRONLY)
                os.dup2(fd, 1)
                os.close(fd)
            os.execv(argv[0], argv)
        self.returncode = None
        self.output = b""

    def poll(self):
        if self.returncode is None:
            waited, status = os.waitpid(self.pid, os.WNOHANG)
            if waited:
                self.returncode = os.waitstatus_to_exitcode(status)
        return self.returncode

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("forkpty supervisor", timeout)
            time.sleep(0.01)
        return self.returncode

    def kill(self):
        os.kill(self.pid, signal.SIGKILL)

    def read_until(self, expected, timeout=5):
        deadline = time.monotonic() + timeout
        while expected not in self.output:
            if time.monotonic() >= deadline:
                raise AssertionError(f"PTY did not produce {expected!r}: {self.output!r}")
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    raise AssertionError(f"PTY closed before {expected!r}: {self.output!r}")
                self.output += chunk
        end = self.output.index(expected) + len(expected)
        output, self.output = self.output[:end], self.output[end:]
        return output

    def send(self, text):
        os.write(self.master, text if isinstance(text, bytes) else text.encode())

    def close(self):
        os.close(self.master)


class SupervisorTests(unittest.TestCase):
    def test_service_reaps_detached_descendants_after_leader_exit(self):
        for mode in ["leader-first", "double-fork", "clone"]:
            with self.subTest(mode=mode):
                result = subprocess.run([BINARY, "service", "--", FIXTURE, mode,
                                         str(self.marker)], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 18 if mode == "clone" else 17,
                                 result.stderr.decode())
                before = self.marker.read_bytes() if self.marker.exists() else b""
                time.sleep(0.1)
                self.assertEqual(self.marker.read_bytes() if self.marker.exists() else b"", before)

    def test_service_forwards_termination_and_leaves_other_service_alive(self):
        peer = subprocess.Popen([BINARY, "service", "--", "/bin/sleep", "30"])
        process = subprocess.Popen([BINARY, "service", "--", "/bin/sh", "-c",
                                    'trap "exit 23" TERM; echo ready; while :; do sleep 1; done'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.extend([peer, process])
        self.assertEqual(process.stdout.readline().strip(), b"ready")
        process.terminate()
        self.assertEqual(process.wait(timeout=5), 23)
        self.assertIsNone(peer.poll())
        peer.terminate()
        self.assertEqual(peer.wait(timeout=5), 143)

    def test_service_child_inherits_no_private_descriptors_or_signal_mask(self):
        for mode, code in [("fd-check", 0), ("signal-check", 19)]:
            result = subprocess.run([BINARY, "service", "--", FIXTURE, mode,
                                     str(self.marker)], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, code, result.stderr.decode())

    def test_capabilities_checks_kernel_without_launching_children(self):
        result = subprocess.run([BINARY, "capabilities"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "native-subreaper-v1")
        self.assertEqual(result.stderr, "")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="og-supervisor-")
        self.root = Path(self.directory.name)
        self.invocation = str(uuid.uuid4())
        self.nonce = "a1" * 32
        self.path = self.root / "control.sock"
        self.marker = self.root / "writes"
        self.children = []
        self.pty = False

    def tearDown(self):
        for process in self.children:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
            if isinstance(process, PtyProcess):
                process.close()
        self.directory.cleanup()

    def flags(self):
        return ["--invocation", self.invocation, "--nonce", self.nonce,
                "--socket", str(self.path), *(["--pty"] if self.pty else [])]

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

    def launch_pty(self, mode=None, command=None, wrapper=None, supervisor=None):
        self.pty = True
        command = command or [FIXTURE, mode, str(self.marker)]
        argv = [*(supervisor or [BINARY]), "launch", *self.flags(), "--", *command]
        if wrapper:
            argv = [FIXTURE, wrapper, *argv]
        process = PtyProcess(argv)
        self.children.append(process)
        self.await_condition(lambda: self.path.exists() or process.poll() is not None)
        self.assertIsNone(process.poll(), "PTY supervisor failed before listening")
        return process

    def interactive_bash(self):
        process = self.launch_pty(command=["/bin/bash", "--noprofile", "--norc", "-i"])
        self.assertEqual(self.control("status"), {"state": "idle"})
        process.send("printf BEFORE_RELEASE\\n\n")
        self.assertEqual(self.control("status"), {"state": "idle"})
        self.control("release")
        output = process.read_until(b"NATIVE_PROMPT> ")
        self.assertNotIn(b"no job control", output)
        # Consume the queued line and its next prompt before testing job control.
        process.read_until(b"NATIVE_PROMPT> ")
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
        self.assertEqual(receipt["protocol"], "native-subreaper-pty-v1" if self.pty else
                         "native-subreaper-v1")
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
                capability = subprocess.run([FIXTURE, mode, BINARY, "capabilities"],
                                            capture_output=True, timeout=3)
                self.assertEqual(capability.returncode, 125)
                self.assertEqual(capability.stdout, b"")
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

    def test_pty_capability_requires_real_foreground_controlling_terminal(self):
        result = subprocess.run([BINARY, "capabilities", "--pty"], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"")
        process = PtyProcess([BINARY, "capabilities", "--pty"])
        self.children.append(process)
        self.assertEqual(process.read_until(b"native-subreaper-pty-v1"),
                         b"native-subreaper-pty-v1")
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())
        redirected = PtyProcess([BINARY, "capabilities", "--pty"], redirected=True)
        self.children.append(redirected)
        self.assertEqual(redirected.wait(timeout=3), 125)

    def test_pty_launch_without_terminal_fails_before_user_code(self):
        self.pty = True
        result = subprocess.run([BINARY, "launch", *self.flags(), "--", "/bin/sh", "-c",
                                 f"touch {self.marker}"], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"")
        self.assertFalse(self.path.exists())
        self.assertFalse(self.marker.exists())

    def test_pty_child_own_group_and_terminal_signals_leave_supervisor_alive(self):
        process = self.launch_pty(command=["/bin/sh", "-c",
                                         "stty -echo; echo CHILD_READY; sleep 3"])
        before = termios.tcgetattr(process.master)
        self.control("release")
        process.read_until(b"CHILD_READY")
        foreground = os.tcgetpgrp(process.master)
        self.assertNotEqual(foreground, process.pid)
        self.assertEqual(os.getpgid(foreground), foreground)
        self.assertEqual(os.getsid(foreground), process.pid)
        for sig in [signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGHUP]:
            os.kill(process.pid, sig)
        self.assertEqual(self.control("status"), {"state": "running"})
        process.send(b"\x03")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 130)
        self.assertEqual(os.tcgetpgrp(process.master), process.pid)
        self.assertEqual(termios.tcgetattr(process.master), before)
        self.ack(process, response)

    def test_pty_interactive_bash_foreground_job_stop_resume_ctrl_c_and_resize(self):
        process = self.interactive_bash()
        shell = os.tcgetpgrp(process.master)
        self.assertNotEqual(shell, process.pid)
        process.send("sleep 3\n")
        self.await_condition(lambda: os.tcgetpgrp(process.master) != shell)
        job = os.tcgetpgrp(process.master)
        self.assertNotEqual(job, process.pid)
        self.assertEqual(os.getsid(job), process.pid)
        process.send(b"\x1a")
        process.read_until(b"Stopped")
        process.read_until(b"NATIVE_PROMPT> ")
        self.assertEqual(os.tcgetpgrp(process.master), shell)
        self.assertEqual(self.control("status"), {"state": "running"})
        process.send("fg\n")
        self.await_condition(lambda: os.tcgetpgrp(process.master) == job)
        process.send(b"\x03")
        process.read_until(b"NATIVE_PROMPT> ")
        self.assertEqual(os.tcgetpgrp(process.master), shell)
        fcntl.ioctl(process.master, termios.TIOCSWINSZ, struct.pack("HHHH", 43, 101, 0, 0))
        process.send("stty size; printf 'RESIZE_DONE\\n'\n")
        output = process.read_until(b"RESIZE_DONE\r\n")
        self.assertIn(b"43 101", output)
        process.send("exit 42\n")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 42)
        self.ack(process, response)

    def test_pty_interactive_cancel_reaps_ignored_term_detached_and_double_fork_jobs(self):
        process = self.interactive_bash()
        shell = os.tcgetpgrp(process.master)
        # These finite fixtures are real Bash foreground/background jobs. The
        # detached job writes after its shell parent has exited unless reaped.
        process.send(f"{FIXTURE} double-fork {self.marker}; "
                     f"{FIXTURE} ignore-term {self.marker}\n")
        self.await_condition(self.marker.exists)
        self.await_condition(lambda: os.tcgetpgrp(process.master) != shell)
        self.assertEqual(self.control("status"), {"state": "running"})
        self.control("cancel")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 137)
        before = self.marker.read_bytes()
        time.sleep(0.12)
        self.assertEqual(self.marker.read_bytes(), before)
        for action in ["status", "release", "cancel"]:
            self.assertEqual(self.control(action), response)
        self.ack(process, response)

    def test_pty_leader_exit_retains_ordinary_detached_command_descendants(self):
        process = self.launch_pty("natural-descendant")
        self.control("release")
        self.await_condition(self.marker.exists)
        self.assertEqual(self.control("status"), {"state": "running"})
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 21)
        self.assertEqual(self.marker.stat().st_size, 50)
        self.ack(process, response)

    def test_pty_authenticated_protocol_negatives_and_idle_cancel(self):
        process = self.launch_pty(command=["/bin/sh", "-c", f"touch {self.marker}"])
        correct = self.nonce
        self.nonce = "b2" * 32
        self.control("release", success=False)
        self.nonce = correct
        correct = self.invocation
        self.invocation = str(uuid.uuid4())
        self.control("release", success=False)
        self.invocation = correct
        self.pty = False
        self.control("release", success=False)
        self.pty = True
        self.assertEqual(self.control("status"), {"state": "idle"})
        self.assertFalse(self.marker.exists())
        self.control("cancel")
        self.control("release")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 125)
        self.control("ack", str(uuid.uuid4()), success=False)
        self.assertEqual(self.control("status"), response)
        self.ack(process, response)

    def test_pty_child_private_descriptor_closure_and_default_signals(self):
        for mode, expected in [("fd-check", 0), ("signal-check", 19), ("tty-signal-check", 20)]:
            with self.subTest(mode=mode):
                process = self.launch_pty(mode, wrapper="sigchld-inherit")
                self.control("release")
                response = self.quiescence()
                self.assertEqual(response["receipt"]["leaderExitCode"], expected)
                self.ack(process, response)

    def test_pty_crash_produces_no_receipt_even_after_leader_exit(self):
        process = self.launch_pty("natural-descendant")
        self.control("release")
        self.await_condition(self.marker.exists)
        process.kill()
        process.wait(timeout=3)
        self.control("status", success=False)
        time.sleep(0.4)

    def test_pty_lost_ack_response_keeps_exact_receipt_until_matching_ack(self):
        process = self.launch_pty(command=["/bin/true"])
        self.control("release")
        response = self.quiescence()
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.connect(str(self.path))
            client.send(f"native-subreaper-pty-v1\t{self.invocation}\t{self.nonce}\tstatus\t-".encode())
        self.assertEqual(self.control("status"), response)
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.connect(str(self.path))
            client.send(f"native-subreaper-pty-v1\t{self.invocation}\t{self.nonce}\tack\t"
                        f"{response['receipt']['receiptId']}".encode())
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())
        self.control("status", success=False)

    def test_pty_unsupported_kernel_primitives_fail_capability_and_launch(self):
        self.pty = True
        for mode in ["deny-pidfd", "deny-send", "deny-wait", "deny-subreaper", "deny-tty"]:
            with self.subTest(mode=mode):
                capability = PtyProcess([FIXTURE, mode, BINARY, "capabilities", "--pty"])
                self.children.append(capability)
                self.assertEqual(capability.wait(timeout=3), 125)
                process = PtyProcess([FIXTURE, mode, BINARY, "launch", *self.flags(), "--",
                                      "/bin/sh", "-c", f"touch {self.marker}"])
                self.children.append(process)
                self.assertEqual(process.wait(timeout=3), 125)
                self.assertFalse(self.path.exists())
                self.assertFalse(self.marker.exists())

    def test_pty_ctrl_c_at_handoff_before_exec_keeps_owner_and_kernel_proof(self):
        process = self.launch_pty(command=["/bin/sh", "-c", f"touch {self.marker}"],
                                  supervisor=[KERNEL, "handoff-signal"])
        self.control("release")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 130)
        self.assertFalse(self.marker.exists())
        self.assertEqual(os.tcgetpgrp(process.master), process.pid)
        self.assertEqual(self.control("status"), response)
        self.ack(process, response)

    def test_pty_child_setup_failure_keeps_owner_and_does_not_execute_user_code(self):
        process = self.launch_pty(command=["/bin/sh", "-c", f"touch {self.marker}"],
                                  wrapper="deny-setpgid")
        self.control("release")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 125)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.control("status"), response)
        self.ack(process, response)

    def test_pty_failed_terminal_handoff_drains_child_before_exec_and_retains_proof(self):
        process = self.launch_pty(command=["/bin/sh", "-c", f"touch {self.marker}"],
                                  supervisor=[KERNEL, "handoff-failure"])
        self.control("release")
        response = self.quiescence()
        self.assertIn(response["receipt"]["leaderExitCode"], [125, 143])
        self.assertFalse(self.marker.exists())
        self.assertEqual(os.tcgetpgrp(process.master), process.pid)
        self.assertEqual(self.control("status"), response)
        self.ack(process, response)

    def test_pty_child_stopped_before_ready_does_not_block_authenticated_cancellation(self):
        process = self.launch_pty(command=["/bin/sh", "-c", f"touch {self.marker}"],
                                  supervisor=[KERNEL, "stop-before-ready"])
        self.control("release")
        child_file = Path(f"/proc/{process.pid}/task/{process.pid}/children")

        def child_stopped():
            children = child_file.read_text().split()
            return bool(children) and "State:\tT" in Path(f"/proc/{children[0]}/status").read_text()

        self.await_condition(child_stopped)
        self.assertEqual(self.control("status"), {"state": "running"})
        self.control("cancel")
        response = self.quiescence()
        self.assertEqual(response["receipt"]["leaderExitCode"], 137)
        self.assertFalse(self.marker.exists())
        self.ack(process, response)


if __name__ == "__main__":
    unittest.main(verbosity=2)
