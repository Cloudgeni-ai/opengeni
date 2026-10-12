"""Exercise the actual native bounded output queue, not provider semantics."""
import base64
import pathlib
import subprocess
import sys
import unittest

BUILD = pathlib.Path(sys.argv.pop(1)).resolve()


class BrokerOutputTests(unittest.TestCase):
    def invoke(self, case):
        result = subprocess.run([str(BUILD / "broker-output"), case], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        return result.stdout

    def test_canonical_binary_frames_and_safe_integer_bounds(self):
        frames = [line.split(b"\t") for line in self.invoke("binary").splitlines()]
        self.assertEqual(len(frames), 2)
        self.assertTrue(all(len(frame) == 12 for frame in frames))
        self.assertEqual([frame[4] for frame in frames], [b"1", b"2"])
        self.assertEqual(frames[0][7:11], [b"stdout", b"0", b"8192", b"base64"])
        self.assertEqual(base64.b64decode(frames[0][11], validate=True), bytes(range(256)) * 32)
        self.assertEqual(frames[1][3], b"9007199254740991")
        self.assertEqual(frames[1][6:12], [b"-", b"status", b"9007199254740991", b"0", b"base64", b""])

    def test_short_writes_do_not_interleave_and_only_sent_prefix_can_be_acknowledged(self):
        self.assertEqual(self.invoke("budget"), b"")

    def test_ack_during_partial_replay_finishes_the_line_before_collection(self):
        self.assertEqual(self.invoke("replay"), b"")

    def test_full_pipe_yields_and_reserved_control_capacity_cannot_be_spent_by_output(self):
        self.assertEqual(self.invoke("pressure"), b"")

    def test_closed_or_blocking_transport_cannot_become_output_completion(self):
        self.assertEqual(self.invoke("failure"), b"")

    def test_invalid_metadata_and_exhaustion_do_not_append(self):
        self.assertEqual(self.invoke("boundaries"), b"")


if __name__ == "__main__":
    unittest.main()
