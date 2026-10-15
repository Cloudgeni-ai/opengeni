// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! Repository structure checks driven by `ARCHITECTURE.toml`.
//!
//! The binary loads a [`Context`] once, runs every rule in
//! [`rules::registered`], and reports [`Finding`]s. Each finding carries the
//! mode of the behaviour that produced it, so a rule can report on every pull
//! request (`advisory`) long before it is allowed to fail one (`required`).

// Upstream builds without clippy's pedantic group. These style lints stay
// allowed so the code keeps diffing cleanly against SPACE's copy.
#![allow(
    clippy::doc_markdown,
    clippy::format_collect,
    clippy::format_push_string,
    clippy::implicit_clone,
    clippy::items_after_statements,
    clippy::must_use_candidate,
    clippy::redundant_closure_for_method_calls,
    clippy::too_many_lines,
    clippy::zero_sized_map_values
)]

pub mod baseline;
pub mod config;
pub mod context;
pub mod finding;
pub mod report;
pub mod rules;

pub use baseline::{BASELINE_FILE, BaseBaseline, Baseline, WriteBaselineError};
pub use config::{ArchitectureConfig, CONFIG_FILE, Mode};
pub use context::{Context, LoadError, ProductionFile};
pub use finding::{Finding, Location};

use std::{collections::BTreeMap, path::Path};

use baseline::BaseSkip;
use rules::NotAdded;

/// Runs every registered rule over `ctx`, in registration order.
pub fn check(ctx: &Context) -> Vec<Finding> {
    rules::registered()
        .iter()
        .flat_map(|rule| rule.check(ctx))
        .collect()
}

/// One line per behaviour [`check`] skipped for lack of an input. A base
/// branch's copy that is not TOML at all skips every comparison with it for
/// one reason, so it gets one line, not one per table.
pub fn skipped(ctx: &Context) -> Vec<String> {
    let rules = rules::registered();
    if let BaseBaseline::Unusable(unusable) = &ctx.base_baseline {
        let comparisons: Vec<String> = rules
            .iter()
            .flat_map(|rule| rule.base_comparisons(ctx))
            .collect();
        return vec![
            BaseSkip::Unusable(unusable).message(&format!("{} skipped", comparisons.join(", "))),
        ];
    }
    rules.iter().flat_map(|rule| rule.skipped(ctx)).collect()
}

/// What [`write_baseline`] or [`write_baseline_table`] wrote, and the
/// violations it left out.
#[derive(Debug)]
pub struct WrittenBaseline {
    pub baseline: Baseline,
    /// One line per violation without an entry, such as `not added: …`.
    pub not_added: Vec<String>,
    /// The entries those violations would need, by table name as
    /// `--write-baseline=<table>` takes it, for adding one by hand.
    pub not_added_entries: BTreeMap<String, BTreeMap<String, usize>>,
}

/// Updates every table of `architecture-baseline.toml` from its entries and
/// the current tree: entries still in violation are kept and updated, the
/// rest are removed, and none are added. A `pattern_ratchet` table the
/// existing baseline lacks is not created; `[file_size]` is always written.
pub fn write_baseline(root: &Path) -> Result<WrittenBaseline, WriteBaselineError> {
    let ctx = Context::load(root)?;
    let (baseline, not_added) = update_baseline(&ctx);
    baseline.write(&root.join(BASELINE_FILE))?;
    Ok(WrittenBaseline::new(baseline, not_added))
}

/// Updates one table of `architecture-baseline.toml`, such as `file_size`
/// or `pattern_ratchet.<instance>`, as [`write_baseline`] does, and keeps
/// every other table as the existing baseline has it. If the existing
/// baseline lacks a `pattern_ratchet` table, the file is left alone: such a
/// table, like an entry, is only ever added by hand.
///
/// The existing baseline must exist, parse and pass the same checks as for
/// `cargo arch`, such as every `pattern_ratchet` table naming a configured
/// instance, so the file written is one the next check accepts. `table` must
/// be `file_size` or a configured instance's table.
pub fn write_baseline_table(
    root: &Path,
    table: &str,
) -> Result<WrittenBaseline, WriteBaselineError> {
    let ctx = Context::load(root)?;
    let known = rules::tables(&ctx.config.rules);
    if !known.iter().any(|name| name == table) {
        return Err(WriteBaselineError::UnknownTable {
            table: table.to_owned(),
            known: known.join(", "),
        });
    }
    let (updated, mut not_added) = update_baseline(&ctx);
    not_added.retain(|entry| entry.table == table);
    let mut baseline = ctx.baseline.clone();
    if baseline.replace_table(&updated, table) {
        baseline.write(&root.join(BASELINE_FILE))?;
    }
    Ok(WrittenBaseline::new(baseline, not_added))
}

impl WrittenBaseline {
    fn new(baseline: Baseline, not_added: Vec<NotAdded>) -> Self {
        let mut not_added_entries: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
        for entry in &not_added {
            not_added_entries
                .entry(entry.table.clone())
                .or_default()
                .insert(entry.path.clone(), entry.count);
        }
        Self {
            baseline,
            not_added: not_added.into_iter().map(|entry| entry.line).collect(),
            not_added_entries,
        }
    }

    /// [`Self::not_added_entries`] as TOML to paste into the baseline, one
    /// block per table, each after a comment saying where it goes. A table
    /// the baseline has gets no header, which pasting would repeat, so its
    /// entries go inside it: at the end of the file they would land in
    /// whichever table comes last. A table it lacks gets its header and can
    /// go at the end.
    pub fn not_added_toml(&self) -> Result<String, toml::ser::Error> {
        let mut text = String::new();
        for (table, entries) in &self.not_added_entries {
            let block = if self.baseline.table(table).is_some() {
                format!(
                    "# add inside the existing [{table}] table, below its header; not at the \
                     end of the file, which may be another table\n"
                )
            } else {
                format!(
                    "# add as a new table, header included, at the end of the file\n[{table}]\n"
                )
            };
            text.push_str(&format!("{block}{}", toml::to_string(entries)?));
        }
        Ok(text)
    }
}

/// Every rule's tables updated from `ctx.baseline`, and the violations
/// without an entry.
fn update_baseline(ctx: &Context) -> (Baseline, Vec<NotAdded>) {
    let mut baseline = Baseline::default();
    let mut not_added = Vec::new();
    for rule in rules::registered() {
        not_added.extend(rule.update_baseline(ctx, &mut baseline));
    }
    (baseline, not_added)
}
