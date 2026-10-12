"""Exact native parser tests: pure decoding, no shell or provider execution."""
from pathlib import Path
import struct
import subprocess
import sys
import unittest

BUILD = Path(sys.argv.pop(1))
BINARY = str(BUILD / "definition")


def encode(cwd="/workspace", argv=None, env=None, pty=False, rows=None, columns=None):
    argv = argv if argv is not None else ["/bin/true"]
    env = env if env is not None else []
    rows = rows if rows is not None else (24 if pty else 0)
    columns = columns if columns is not None else (80 if pty else 0)
    header = b"OGCD1\0" + struct.pack(">BBHHII", int(pty), 0, rows, columns, len(argv), len(env))
    strings = [cwd, *argv, *[string for pair in env for string in pair]]
    return header + b"".join(struct.pack(">I", len(data)) + data
                             for string in strings
                             for data in [string if isinstance(string, bytes) else string.encode()])


class BrokerDefinitionTests(unittest.TestCase):
    def invoke(self, data, valid):
        result = subprocess.run([BINARY], input=data, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0 if valid else 125, result.stderr)
        self.assertEqual(result.stdout, data if valid else b"")
        self.assertEqual(result.stderr, b"")

    def test_pipe_and_pty_round_trip_literal_strings_without_interpolation(self):
        for pty in [False, True]:
            self.invoke(encode(cwd="/workspace/🦎 α", argv=["/bin/sh", "-c", "printf '$NAME'", ""],
                               env=[["NAME", "line1\nline2\t=🦎"], ["EMPTY", ""], ["__proto__", "literal"]],
                               pty=pty), True)

    def test_frozen_minimal_vector_matches_host_contract(self):
        data = encode(cwd="/", argv=["x"])
        self.assertEqual(data.hex(), "4f47434431000000000000000000000100000000000000012f0000000178")
        self.invoke(data, True)

    def test_every_truncated_prefix_is_rejected_and_frees_state(self):
        data = encode(env=[["ONE", "1"], ["TWO", "two"]])
        for length in range(len(data)):
            with self.subTest(length=length):
                self.invoke(data[:length], False)

    def test_header_reserved_flags_counts_and_trailing_bytes_rejected(self):
        data = encode()
        for offset, value in [(0, 0), (4, ord("2")), (5, 1), (6, 2), (7, 1), (12, 0xff), (16, 0xff)]:
            corrupted = bytearray(data)
            corrupted[offset] = value
            self.invoke(bytes(corrupted), False)
        self.invoke(data + b"\0", False)
        self.invoke(data + data, False)
        self.invoke(encode(argv=[]), False)
        self.invoke(encode(argv=["x"] * 1025), False)
        self.invoke(encode(env=[[f"K{i}", ""] for i in range(1025)]), False)

    def test_mode_dimension_rules(self):
        for pty, rows, columns, valid in [(False, 1, 0, False), (False, 0, 1, False),
                                         (True, 0, 1, False), (True, 1, 0, False),
                                         (True, 65535, 65535, True)]:
            self.invoke(encode(pty=pty, rows=rows, columns=columns), valid)

    def test_cwd_and_executable_are_explicit_and_nonempty(self):
        for cwd in ["", "relative", "./relative", "\0/"]:
            self.invoke(encode(cwd=cwd), False)
        self.invoke(encode(argv=[""]), False)
        self.invoke(encode(argv=["/bin/sh", ""]), True)

    def test_invalid_utf8_nuls_overlong_surrogates_and_bounds_rejected(self):
        for data in [b"\0", b"a\0b", b"\x80", b"\xc0\xaf", b"\xe0\x80\xaf",
                     b"\xed\xa0\x80", b"\xf4\x90\x80\x80", b"\xf5\x80\x80\x80",
                     b"\xe2\x82", b"\xff", b"\xc2x"]:
            self.invoke(encode(argv=[b"x", data]), False)
        for data in [b"\xc2\x80", b"\xe0\xa0\x80", b"\xf0\x90\x80\x80", b"\xf4\x8f\xbf\xbf"]:
            self.invoke(encode(argv=[b"x", data]), True)

    def test_environment_duplicate_names_bad_names_and_combined_string_limit(self):
        for name in ["", "1A", "A=B", "A-B", "A B", "α", "A\0B"]:
            self.invoke(encode(env=[[name, "value"]]), False)
        self.invoke(encode(env=[["A", "1"], ["A", "2"]]), False)
        self.invoke(encode(env=[["A", "1"], ["AA", "2"]]), True)
        self.invoke(encode(env=[["AA", "1"], ["A", "2"]]), True)
        self.invoke(encode(env=[["A", "x" * (131071 - 2)]]), True)
        self.invoke(encode(env=[["A", "x" * (131071 - 1)]]), False)

    def test_exact_string_entry_and_aggregate_bounds(self):
        self.invoke(encode(argv=["x", "a" * 131071]), True)
        self.invoke(encode(argv=["x", "a" * 131072]), False)
        self.invoke(encode(argv=["x"] * 1024), True)
        self.invoke(encode(env=[[f"K{i}", ""] for i in range(1024)]), True)
        # Header20, cwd5, two argv string prefixes8 => 33 bytes overhead.
        exact = encode(cwd="/", argv=["a" * 131071, "b" * (262144 - 33 - 131071)])
        self.assertEqual(len(exact), 262144)
        self.invoke(exact, True)
        self.invoke(exact + b"x", False)


if __name__ == "__main__":
    unittest.main()
