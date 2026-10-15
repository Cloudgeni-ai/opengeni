// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! The compute workspace's own `ARCHITECTURE.toml` and baseline stay loadable,
//! and no required-mode rule fails on the tree as committed.

use std::path::Path;

use compute_archcheck::{Context, check};

#[test]
fn repository_config_and_baseline_pass_every_required_rule() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let ctx = Context::load(&root).unwrap();
    assert!(!ctx.files.is_empty());

    let required: Vec<_> = check(&ctx)
        .into_iter()
        .filter(|finding| finding.mode.is_required())
        .collect();
    assert!(required.is_empty(), "{required:#?}");
}
