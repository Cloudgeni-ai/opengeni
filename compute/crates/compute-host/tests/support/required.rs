//! Tests that need a lab host or a store skip elsewhere. A gate lists what
//! it provides in `COMPUTE_TEST_REQUIRE` (`lab`, `store`, `chunked` for a
//! chunked store, `lan`), and there a test that would skip for want of one
//! fails instead, so a misconfigured gate cannot pass without running it.

/// Notes that a test cannot run here for want of `need`, and why: a skip,
/// or a failure if `COMPUTE_TEST_REQUIRE` lists `need`.
pub fn skip(need: &str, why: &str) {
    let required = std::env::var("COMPUTE_TEST_REQUIRE").unwrap_or_default();
    assert!(
        !required.split(',').any(|listed| listed.trim() == need),
        "a required test cannot run: {why}"
    );
    eprintln!("skipped: {why}");
}
