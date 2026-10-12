"""Closed native request framing tests. Parsing never grants execution."""
import base64
from pathlib import Path
import subprocess
import sys
import unittest

BUILD = Path(sys.argv.pop(1))
BINARY = str(BUILD / "broker-wire")
BROKER = "11111111-1111-4111-8111-111111111111"
REQUEST = "22222222-2222-4222-8222-222222222222"
COMMAND = "33333333-3333-4333-8333-333333333333"


def frame(payload=b"", **overrides):
    values = dict(direction="request", broker=BROKER, epoch="1", sequence="1", request=REQUEST,
                  command=COMMAND, kind="stdin", offset="0", size=str(len(payload)),
                  encoding="base64", payload=base64.b64encode(payload).decode())
    values.update(overrides)
    return ("OGB1\t" + "\t".join(values.values()) + "\n").encode()


class BrokerWireTests(unittest.TestCase):
    def invoke(self, data, valid, broker=BROKER):
        result = subprocess.run([BINARY, broker], input=data, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0 if valid else 125, result.stderr)
        self.assertEqual(result.stdout, data if valid else b"")
        self.assertEqual(result.stderr, b"")

    def test_all_request_kinds_and_binary_payload_round_trip(self):
        for kind in ["hello", "fence", "prepare", "definition", "launch", "stdin", "eof",
                     "resize", "control", "ack", "replay"]:
            self.invoke(frame(bytes([0, 255, 128, 10, 9, 13]), kind=kind), True)
        self.invoke(frame(command="-", kind="fence"), True)

    def test_every_truncated_prefix_fails_without_partial_acceptance(self):
        data = frame(b"literal\x00binary")
        for size in range(len(data)):
            self.invoke(data[:size], False)

    def test_closed_header_identity_and_direction(self):
        for field, value in [("direction", "response"), ("broker", COMMAND), ("request", "invalid"),
                             ("command", "invalid"), ("kind", "accepted"), ("kind", "shell"),
                             ("encoding", "utf8"), ("epoch", "0"), ("sequence", "0"),
                             ("request", REQUEST.replace("4222", "0222")),
                             ("command", COMMAND.replace("8333", "c333"))]:
            self.invoke(frame(**{field: value}), False)
        self.invoke(frame(), False, broker=COMMAND)
        self.invoke(frame(), False, broker="invalid")

    def test_decimal_spelling_precision_and_offset_arithmetic(self):
        for field in ["epoch", "sequence", "offset", "size"]:
            for value in ["", "01", "+1", "-1", " 1", "1e0", "1.0", "9007199254740992", "9" * 60]:
                self.invoke(frame(**{field: value}), False)
        self.invoke(frame(b"a", offset="9007199254740991"), False)
        self.invoke(frame(offset="9007199254740991", epoch="9007199254740991",
                          sequence="9007199254740991"), True)

    def test_canonical_base64_and_byte_count(self):
        good = frame(b"a").decode()
        for encoded in ["YR==", "YQ", "Y Q==", "YQ===", "YQ==\t", "====", "YWJ=", "YWJj"]:
            self.invoke(good.replace("YQ==", encoded).encode(), False)
        self.invoke(frame(b"ab").replace(b"YWI=", b"YWJ="), False)
        self.invoke(frame(b"abc"), True)
        self.invoke(frame(size="1"), False)

    def test_ascii_line_boundaries_and_payload_limit(self):
        good = frame(b"a")
        for data in [good + good, good + b"x", b" " + good, good.replace(b"\n", b"\r\n"),
                     good.replace(b"OGB1", b"OGB1\0"), good.replace(b"stdin", "st🦎din".encode())]:
            self.invoke(data, False)
        self.invoke(frame(b"\xff" * 8192), True)
        self.invoke(frame(b"\xff" * 8193), False)
        self.invoke(b"x" * (12 * 1024) + b"\n", False)


if __name__ == "__main__":
    unittest.main()
