# Derived from SPACE's space_smoke/scenarios/ecw_filesystem_watcher.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW recursive filesystem watcher behavior."""

import compute_smoke as smoke

WORKDIR = "/tmp/space-smoke-watcher"
NESTED_DIR = f"{WORKDIR}/nested"
WATCH_PATH = f"{NESTED_DIR}/watched.txt"
PAYLOAD = "space-smoke-watcher-ok"


@smoke.scenario("ecw.filesystem_watcher")
def filesystem_watcher(test: smoke.Ecw) -> None:
    """A recursive ECW filesystem watcher reports a write to the exact nested
    path and can be stopped through its SDK handle.
    """

    with test.phase("prepare watched directory"):
        test.sandbox.files.make_dir(WORKDIR)
        test.sandbox.files.make_dir(NESTED_DIR)

    with (
        test.phase("observe nested file write and stop watcher"),
        test.watch_directory(WORKDIR, recursive=True) as watcher,
    ):
        test.sandbox.files.write(WATCH_PATH, PAYLOAD)
        watcher.expect_change(WATCH_PATH)
