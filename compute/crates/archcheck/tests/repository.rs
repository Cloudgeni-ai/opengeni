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

/// The pure-core rule catches ordinary ways of reaching I/O and the clock,
/// not only fully qualified paths, and leaves pure std alone.
#[test]
fn the_pure_core_rule_sees_through_ordinary_imports() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let ctx = Context::load(&root).unwrap();
    let rule = &ctx.config.rules.pattern_ratchet["pure_core"];
    for line in [
        "use std::fs;",
        "use std::{fs, thread};",
        "use std::{collections::BTreeMap, io::Write};",
        "    fs,",
        "    thread as threads,",
        "    process};",
        "    fs::write(path, data)?;",
        "let handle = thread::spawn(work);",
        "let name = env::var(\"X\");",
        "use std::io::Write;",
        "use std::os::unix::net::UnixStream;",
        "use std::time::Instant as Clock;",
        "let started = Clock::now();",
        "use std::time::{Duration, SystemTime};",
        "println!(\"{x}\");",
        "dbg!(state);",
        "let delay = rand::random::<u64>();",
        "use tokio::sync::mpsc;",
    ] {
        assert!(rule.patterns.is_match(line), "not caught: {line}");
    }
    for line in [
        "use std::time::Duration;",
        "use std::collections::{BTreeMap, BTreeSet};",
        "let next = self.process(input);",
        "crate::host::process::Step::Boot",
        "let io_bound = true;",
        "format!(\"{x}\")",
    ] {
        assert!(!rule.patterns.is_match(line), "falsely caught: {line}");
    }
}
