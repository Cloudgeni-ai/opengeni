# Derived from SPACE's space_smoke/scenarios/ecw_filesystem_mutations.py
# (https://github.com/perplexityai/SPACE, Apache-2.0, Copyright 2026 Perplexity AI)
# and changed for Opengeni compute; see compute/NOTICE.
"""ECW filesystem mutation happy path."""

import io

import compute_smoke as smoke

ROOT = "/tmp/space-smoke/filesystem-mutations"
NESTED_DIR = f"{ROOT}/missing/parents"
ORIGINAL_PATH = f"{NESTED_DIR}/before.txt"
RENAMED_PATH = f"{NESTED_DIR}/after.txt"
SIBLING_PATH = f"{NESTED_DIR}/sibling.bin"
CONTENT = "space-smoke-filesystem-mutations"
SIBLING_CONTENT = b"\x00\x01\x02\x03\xff"


@smoke.scenario("ecw.filesystem_mutations")
def filesystem_mutations(test: smoke.Ecw) -> None:
    """ECW filesystem operations create explicit and missing directories,
    preserve streamed content, expose renames and file removal, and recursively
    remove a non-empty tree.
    """

    with test.phase("create directory and nested files"):
        nested_existed_before = test.sandbox.files.exists(NESTED_DIR)
        test.sandbox.files.make_dir(ROOT)
        root_exists = test.sandbox.files.exists(ROOT)
        test.sandbox.files.write(ORIGINAL_PATH, CONTENT)
        test.sandbox.files.write(SIBLING_PATH, io.BytesIO(SIBLING_CONTENT))
        nested_exists_after = test.sandbox.files.exists(NESTED_DIR)
        observed_content = test.sandbox.files.read(ORIGINAL_PATH)
        observed_sibling = test.sandbox.files.read_bytes(SIBLING_PATH)
        names = {entry.name for entry in test.sandbox.files.list(NESTED_DIR)}
        test.verify(
            root_exists,
            "Files API MakeDir did not create the requested directory",
            directory=ROOT,
        )
        test.verify(
            not nested_existed_before and nested_exists_after and observed_content == CONTENT,
            "Files API write did not auto-create missing parents and preserve content",
            nested_existed_before=nested_existed_before,
            nested_exists_after=nested_exists_after,
            expected_text=CONTENT,
            observed_text=observed_content,
        )
        test.verify(
            observed_sibling == SIBLING_CONTENT,
            "Files API streamed write changed the binary content",
            expected_streamed_bytes=SIBLING_CONTENT.hex(),
            observed_streamed_bytes=observed_sibling.hex(),
        )
        test.verify(
            names == {"before.txt", "sibling.bin"},
            "ECW directory listing did not return every nested file",
            listed_names=sorted(names),
        )

    with test.phase("rename and observe file"):
        test.sandbox.files.rename(ORIGINAL_PATH, RENAMED_PATH)
        original_exists = test.sandbox.files.exists(ORIGINAL_PATH)
        renamed_exists = test.sandbox.files.exists(RENAMED_PATH)
        renamed_names = {entry.name for entry in test.sandbox.files.list(NESTED_DIR)}
        test.verify(
            renamed_exists
            and not original_exists
            and renamed_names == {"after.txt", "sibling.bin"},
            "Files API rename was not reflected by listing and stat",
            original_exists=original_exists,
            renamed_exists=renamed_exists,
            listed_names=sorted(renamed_names),
        )

    with test.phase("remove a file and its non-empty tree"):
        test.sandbox.files.remove(SIBLING_PATH)
        sibling_exists_after_remove = test.sandbox.files.exists(SIBLING_PATH)
        test.verify(
            not sibling_exists_after_remove,
            "Files API remove returned without removing the file",
            path=SIBLING_PATH,
            exists_after_remove=sibling_exists_after_remove,
        )

        test.sandbox.files.remove(ROOT)
        root_exists_after_remove = test.sandbox.files.exists(ROOT)
        renamed_exists_after_tree_remove = test.sandbox.files.exists(RENAMED_PATH)
        test.verify(
            not root_exists_after_remove and not renamed_exists_after_tree_remove,
            "Files API remove did not recursively remove the non-empty directory",
            directory=ROOT,
            directory_exists_after_remove=root_exists_after_remove,
            nested_file_exists_after_remove=renamed_exists_after_tree_remove,
        )
