# Derived from SPACE's space_smoke/scenarios/ecw_binary_file_round_trip.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW binary filesystem happy path."""

from hashlib import sha256

import compute_smoke as smoke

PATH = "/tmp/space-smoke/binary-round-trip.bin"
CONTENT = bytes(range(256)) * 16


@smoke.scenario("ecw.binary_file_round_trip")
def binary_file_round_trip(test: smoke.Ecw) -> None:
    """Arbitrary bytes written through the ECW Files API can be read back
    without text conversion or corruption.
    """

    with test.phase("write and read binary file"):
        test.sandbox.files.write(PATH, CONTENT)
        observed = test.sandbox.files.read_bytes(PATH)
        test.verify(
            observed == CONTENT,
            "ECW binary file content changed during round trip",
            path=PATH,
            expected_bytes=len(CONTENT),
            observed_bytes=len(observed),
            expected_sha256=sha256(CONTENT).hexdigest(),
            observed_sha256=sha256(observed).hexdigest(),
        )
