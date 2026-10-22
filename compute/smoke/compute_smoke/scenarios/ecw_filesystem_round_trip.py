# Derived from SPACE's space_smoke/scenarios/ecw_filesystem_round_trip.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW filesystem happy path."""

import compute_smoke as smoke

PATH = "/tmp/space-smoke/filesystem-round-trip.txt"
CONTENT = "space-smoke-filesystem-ok"


@smoke.scenario("ecw.filesystem_round_trip")
def filesystem_round_trip(test: smoke.Ecw) -> None:
    """Text written through the ECW Files API can be read back exactly."""

    with test.phase("write and read marker file"):
        test.sandbox.files.write(PATH, CONTENT)
        observed = test.sandbox.files.read(PATH)
        test.verify(
            observed == CONTENT,
            "ECW file read did not return the content that was written",
            path=PATH,
            expected_content=CONTENT,
            observed_content=observed,
        )
