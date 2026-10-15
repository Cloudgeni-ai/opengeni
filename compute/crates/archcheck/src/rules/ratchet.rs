// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! A per-file count ratchet: the five behaviours every rule with a baseline
//! table shares.
//!
//! A rule measures each production file, as a count and the line it starts
//! on, and a file it measures is in violation. Its baseline table caps the
//! count of each listed file. `no_crossing` keeps files outside the table
//! from violating; `no_new_entries` and `no_raised_caps` report entries a pull
//! request adds to the table and caps it raises, compared with the base
//! branch's copy, so the table is not a way around `no_crossing`;
//! `listed_no_growth` keeps every listed file's count from growing past its
//! cap; `stale_entries` asks for an entry to be lowered or removed once its
//! file's count shrinks, it no longer violates, or it is gone. The last two
//! are separate so that requiring no growth does not also fail the change
//! that shrinks a file.
//!
//! [`CountRule`] is all a rule implements: its measurement and its wording,
//! one [`CountRatchet`] per table. This module owns the behaviours, where
//! findings point, the comparisons with the base branch's copy, and
//! `--write-baseline`, which updates or removes entries but never adds one.

use std::collections::BTreeMap;

use crate::{
    baseline::{BASELINE_FILE, Baseline, NO_ENTRIES, rule_of},
    config::{Mode, RulesConfig},
    context::{Context, ProductionFile},
    finding::{Finding, Location},
    rules::{NotAdded, Rule},
};

#[cfg(test)]
mod tests;

pub const NO_CROSSING: &str = "no_crossing";
pub const NO_NEW_ENTRIES: &str = "no_new_entries";
pub const NO_RAISED_CAPS: &str = "no_raised_caps";
pub const LISTED_NO_GROWTH: &str = "listed_no_growth";
pub const STALE_ENTRIES: &str = "stale_entries";

/// A rule made of per-file count ratchets, one per baseline table.
pub trait CountRule {
    /// The rule's name, as in its finding codes and baseline tables.
    const NAME: &'static str;

    /// One ratchet per configured table, in reporting order.
    fn ratchets<'a>(&self, config: &'a RulesConfig) -> Vec<Box<dyn CountRatchet + 'a>>;
}

/// One baseline table's measurement and wording.
pub trait CountRatchet {
    /// The instance, for a rule configured as several named instances.
    fn instance(&self) -> Option<&str> {
        None
    }

    fn modes(&self) -> Modes;

    /// `file`'s count, if it violates the rule, such as by being over a
    /// limit; `None` for a file the rule allows, which is never counted.
    fn measure(&self, file: &ProductionFile) -> Option<Count>;

    fn wording(&self) -> Wording;

    /// The `no_crossing` detail for a file outside the table, such as `": 1200
    /// code lines, over the 1,000-line limit…"`.
    fn crossing(&self, count: Count) -> String;

    /// Why a listed file that no longer violates is fine, such as `" is down
    /// to 900 code lines, within the 1,000-line limit"`.
    fn cleared(&self, file: &ProductionFile) -> String;

    /// A count in a `not added` line, such as `1200 code lines`.
    fn counted(&self, count: usize) -> String;
}

/// A file's count of what the rule restricts, and the 1-based line it
/// starts on, where findings about the file's count point.
#[derive(Debug, Clone, Copy)]
pub struct Count {
    pub count: usize,
    pub first_line: usize,
}

/// Each behaviour's mode.
#[derive(Debug, Clone, Copy)]
pub struct Modes {
    pub no_crossing: Mode,
    pub no_new_entries: Mode,
    pub no_raised_caps: Mode,
    pub listed_no_growth: Mode,
    pub stale_entries: Mode,
}

/// The phrases the findings and `not added` lines of a table are built
/// from.
#[derive(Debug)]
pub struct Wording {
    /// Where the table is, such as `architecture-baseline.toml`.
    pub place: String,
    /// The files the table is no way around, such as `files over the
    /// 1,000-line limit`.
    pub violators: String,
    /// What to do instead of adding an entry or raising a cap, such as
    /// `Split the file`.
    pub fix: String,
    /// What a count counts, such as `code lines`.
    pub unit: String,
    /// What to do instead of growing, such as `split the file before adding
    /// to it`.
    pub growth_fix: String,
    /// What to do instead of adding an entry, such as `split it`.
    pub not_added_fix: String,
}

impl<R: CountRule> Rule for R {
    fn check(&self, ctx: &Context) -> Vec<Finding> {
        self.ratchets(&ctx.config.rules)
            .iter()
            .flat_map(|ratchet| check(ctx, R::NAME, ratchet.as_ref()))
            .collect()
    }

    /// A line per table whose comparisons are skipped, then one per table of
    /// the base branch's copy that is not configured, such as one for a
    /// renamed or removed instance, so that the removal shows in the log.
    fn skipped(&self, ctx: &Context) -> Vec<String> {
        let ratchets = self.ratchets(&ctx.config.rules);
        let skipped = ratchets.iter().filter_map(|ratchet| {
            let table = table_name(R::NAME, ratchet.instance());
            let skip = ctx.base_baseline.table(&table).err()?;
            Some(skip.message(&format!("{} skipped", base_comparisons(&table))))
        });
        let tables = self.tables(&ctx.config.rules);
        let unconfigured = ctx
            .base_baseline
            .table_names()
            .filter(|table| rule_of(table) == R::NAME && !tables.iter().any(|name| name == table))
            .map(|table| format!("base baseline has [{table}], which is not configured; skipped"));
        skipped.chain(unconfigured).collect()
    }

    fn base_comparisons(&self, ctx: &Context) -> Vec<String> {
        self.tables(&ctx.config.rules)
            .iter()
            .map(|table| base_comparisons(table))
            .collect()
    }

    fn baseline_rule(&self) -> Option<&'static str> {
        Some(R::NAME)
    }

    fn tables(&self, config: &RulesConfig) -> Vec<String> {
        self.ratchets(config)
            .iter()
            .map(|ratchet| table_name(R::NAME, ratchet.instance()))
            .collect()
    }

    /// Keeps each listed file that still violates, at its current count,
    /// even above its cap, which `no_raised_caps` then reports. A file
    /// without an entry is not added, and a table `ctx.baseline` lacks is not
    /// created: either takes a hand edit, which `no_new_entries` then
    /// reports.
    fn update_baseline(&self, ctx: &Context, baseline: &mut Baseline) -> Vec<NotAdded> {
        self.ratchets(&ctx.config.rules)
            .iter()
            .flat_map(|ratchet| update_baseline(ctx, R::NAME, ratchet.as_ref(), baseline))
            .collect()
    }
}

/// `<rule>`, or `<rule>.<instance>`: the table's name in the baseline, as
/// `--write-baseline=<table>` takes it, and its findings' code prefix.
fn table_name(rule: &str, instance: Option<&str>) -> String {
    match instance {
        Some(instance) => format!("{rule}.{instance}"),
        None => rule.to_owned(),
    }
}

/// The behaviours of `table` that compare with the base branch's copy.
fn base_comparisons(table: &str) -> String {
    format!("{table}.{NO_NEW_ENTRIES} and {table}.{NO_RAISED_CAPS}")
}

fn check(ctx: &Context, rule: &'static str, ratchet: &dyn CountRatchet) -> Vec<Finding> {
    let table = table_name(rule, ratchet.instance());
    let caps = ctx.baseline.table(&table).unwrap_or(&NO_ENTRIES);
    let modes = ratchet.modes();
    let wording = ratchet.wording();
    let place = &wording.place;
    let finding =
        |behaviour: &'static str, mode: Mode, path: &str, detail: String, line: usize| Finding {
            rule,
            instance: ratchet.instance().map(str::to_owned),
            behaviour,
            path: path.to_owned(),
            detail,
            mode,
            location: Location {
                path: path.to_owned(),
                line,
            },
        };
    // A finding about an entry itself is shown on the entry's line.
    let entry_finding = |behaviour: &'static str, mode: Mode, path: &str, detail: String| Finding {
        location: Location {
            path: BASELINE_FILE.to_owned(),
            line: ctx.baseline.entry_line(&table, path).unwrap_or(1),
        },
        ..finding(behaviour, mode, path, detail, 1)
    };
    let mut findings = Vec::new();

    let mut measured = BTreeMap::new();
    for file in &ctx.files {
        let Some(count) = ratchet.measure(file) else {
            continue;
        };
        if !caps.contains_key(&file.path) {
            findings.push(finding(
                NO_CROSSING,
                modes.no_crossing,
                &file.path,
                ratchet.crossing(count),
                count.first_line,
            ));
        }
        measured.insert(file.path.as_str(), count);
    }

    if let Ok(base) = ctx.base_baseline.table(&table) {
        for path in caps.keys().filter(|path| !base.contains_key(*path)) {
            findings.push(entry_finding(
                NO_NEW_ENTRIES,
                modes.no_new_entries,
                path,
                format!(
                    " is in {place} but not in the base branch's copy; {} can't be added (a \
                     renamed file counts as added). {} instead.",
                    wording.violators, wording.fix,
                ),
            ));
        }
        for (path, &cap) in caps {
            if let Some(&base_cap) = base.get(path)
                && cap > base_cap
            {
                findings.push(entry_finding(
                    NO_RAISED_CAPS,
                    modes.no_raised_caps,
                    path,
                    format!(
                        ": cap raised from {base_cap} to {cap} in {place}; caps should only go \
                         down. {} instead.",
                        wording.fix,
                    ),
                ));
            }
        }
    }

    let growth_mode = modes.listed_no_growth;
    let stale_mode = modes.stale_entries;
    let unit = &wording.unit;
    let mut stale = Vec::new();
    for (path, &cap) in caps {
        // The file is gone, so the finding points at its entry.
        let Some(file) = ctx.file(path) else {
            stale.push(entry_finding(
                STALE_ENTRIES,
                stale_mode,
                path,
                format!(
                    ": listed in {place} but no longer a production Rust file. Remove the entry; \
                     a renamed file is checked under its new path."
                ),
            ));
            continue;
        };
        match measured.get(path.as_str()).copied() {
            None => stale.push(finding(
                STALE_ENTRIES,
                stale_mode,
                path,
                format!("{}. Remove it from {place}.", ratchet.cleared(file)),
                1,
            )),
            Some(Count { count, first_line }) if count > cap => {
                let advice = if growth_mode.is_required() {
                    format!("{}.", capitalized(&wording.growth_fix))
                } else {
                    format!("Once this rule is required, {}.", wording.growth_fix)
                };
                findings.push(finding(
                    LISTED_NO_GROWTH,
                    growth_mode,
                    path,
                    format!(" grew from {cap} to {count} {unit}. {advice}"),
                    first_line,
                ));
            }
            Some(Count { count, first_line }) if count < cap => stale.push(finding(
                STALE_ENTRIES,
                stale_mode,
                path,
                format!(
                    " shrank from {cap} to {count} {unit}. Lower its cap in {place} to {count}."
                ),
                first_line,
            )),
            Some(_) => {}
        }
    }
    // Each behaviour's findings stay contiguous for the human report.
    findings.append(&mut stale);

    findings
}

fn update_baseline(
    ctx: &Context,
    rule: &'static str,
    ratchet: &dyn CountRatchet,
    baseline: &mut Baseline,
) -> Vec<NotAdded> {
    let table = table_name(rule, ratchet.instance());
    let listed = ctx.baseline.table(&table);
    let advice = if listed.is_some() {
        format!(
            "{}, or add an entry by hand if this is a deliberate exception",
            ratchet.wording().not_added_fix
        )
    } else if ratchet.instance().is_some() {
        format!(
            "{BASELINE_FILE} has no [{table}] table; for a new instance, add the table and its \
             entries by hand"
        )
    } else {
        format!("{BASELINE_FILE} has no [{table}] table; add the table and its entries by hand")
    };
    let mut caps = BTreeMap::new();
    let mut not_added = Vec::new();
    for file in &ctx.files {
        let Some(Count { count, .. }) = ratchet.measure(file) else {
            continue;
        };
        if listed.is_some_and(|listed| listed.contains_key(&file.path)) {
            caps.insert(file.path.clone(), count);
        } else {
            not_added.push(NotAdded {
                table: table.clone(),
                path: file.path.clone(),
                count,
                line: format!(
                    "not added: {} ({}); {advice}",
                    file.path,
                    ratchet.counted(count)
                ),
            });
        }
    }
    if listed.is_some() {
        baseline.insert_table(table, caps);
    }
    not_added
}

/// `phrase` with its first letter in upper case.
fn capitalized(phrase: &str) -> String {
    let mut chars = phrase.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
