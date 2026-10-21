# Derived from SPACE's space_smoke/scenarios/ecw_large_stdout_integrity.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW large command-output happy path."""

from hashlib import sha256

import compute_smoke as smoke

PATH = "/tmp/space-smoke/large-stdout.txt"
PAYLOAD_BYTES = 2_000_000
PATTERN = "0123456789abcdef"


@smoke.scenario("ecw.large_stdout_integrity")
def large_stdout_integrity(test: smoke.Ecw) -> None:
    """A large Files API payload is stored byte-exactly and crosses the ECW
    process stream without truncation, duplication, or corruption.
    """

    payload = (PATTERN * ((PAYLOAD_BYTES // len(PATTERN)) + 1))[:PAYLOAD_BYTES]
    payload_bytes = payload.encode()
    expected_sha256 = sha256(payload_bytes).hexdigest()

    with test.phase("seed and read large command output"):
        test.sandbox.files.write(PATH, payload)
        stored = test.sandbox.files.read_bytes(PATH)
        test.verify(
            stored == payload_bytes,
            "large stdout fixture changed during its Files API round trip",
            expected_bytes=PAYLOAD_BYTES,
            observed_bytes=len(stored),
            expected_sha256=expected_sha256,
            observed_sha256=sha256(stored).hexdigest(),
        )

    with test.phase("stream and verify large command output"):
        result = test.sandbox.run(f"cat {PATH}", timeout=90)
        observed_sha256 = sha256(result.stdout.encode()).hexdigest()
        test.verify(
            result.exit_code == 0
            and len(result.stdout) == PAYLOAD_BYTES
            and observed_sha256 == expected_sha256,
            "large ECW command output was truncated or corrupted",
            expected_bytes=PAYLOAD_BYTES,
            observed_bytes=len(result.stdout),
            expected_sha256=expected_sha256,
            observed_sha256=observed_sha256,
            command_stderr=result.stderr,
        )
