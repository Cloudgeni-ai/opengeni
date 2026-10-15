// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! The shared ratchet's paths that neither registered rule reaches: a rule
//! without instances whose table is missing, a base copy that does not read
//! a rule's tables, and entries without a recorded line.

use std::{collections::BTreeMap, fs};

use super::*;
use crate::{
    baseline::BaseBaseline,
    context::{code_lines, count_code_lines},
};

/// A rule without instances that counts the code lines reading `hit`.
struct Hits;

impl CountRule for Hits {
    const NAME: &'static str = "hits";

    fn ratchets<'a>(&self, _config: &'a RulesConfig) -> Vec<Box<dyn CountRatchet + 'a>> {
        vec![Box::new(Hits)]
    }
}

impl CountRatchet for Hits {
    fn modes(&self) -> Modes {
        Modes {
            no_crossing: Mode::Advisory,
            no_new_entries: Mode::Advisory,
            no_raised_caps: Mode::Advisory,
            listed_no_growth: Mode::Advisory,
            stale_entries: Mode::Advisory,
        }
    }

    fn measure(&self, file: &ProductionFile) -> Option<Count> {
        let mut lines = code_lines(&file.text)
            .filter(|(_, line)| *line == "hit")
            .map(|(number, _)| number);
        let first_line = lines.next()?;
        Some(Count {
            count: 1 + lines.count(),
            first_line,
        })
    }

    fn wording(&self) -> Wording {
        Wording {
            place: "[hits]".to_owned(),
            violators: "files with hits".to_owned(),
            fix: "Remove the hits".to_owned(),
            unit: "hits".to_owned(),
            growth_fix: "remove the new hits".to_owned(),
            not_added_fix: "remove them".to_owned(),
        }
    }

    fn crossing(&self, count: Count) -> String {
        format!(": {} hits", count.count)
    }

    fn cleared(&self, _file: &ProductionFile) -> String {
        " has no hits left".to_owned()
    }

    fn counted(&self, count: usize) -> String {
        format!("{count} hits")
    }
}

fn context(baseline: Baseline, files: &[(&str, &str)]) -> Context {
    let config = "[rules.file_size]\nlimit = 5\n\
                  [rules.file_size.no_crossing]\nmode = \"advisory\"\n\
                  [rules.file_size.no_new_entries]\nmode = \"advisory\"\n\
                  [rules.file_size.no_raised_caps]\nmode = \"advisory\"\n\
                  [rules.file_size.listed_no_growth]\nmode = \"advisory\"\n\
                  [rules.file_size.stale_entries]\nmode = \"advisory\"\n";
    let mut files: Vec<ProductionFile> = files
        .iter()
        .map(|(path, text)| ProductionFile {
            path: (*path).to_owned(),
            text: (*text).to_owned(),
            code_lines: count_code_lines(text),
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Context {
        config: toml::from_str(config).expect("the configuration parses"),
        baseline,
        base_baseline: BaseBaseline::NotGiven,
        files,
    }
}

/// `(code, message, location)` of each finding.
fn findings(ctx: &Context) -> Vec<(String, String, Location)> {
    Rule::check(&Hits, ctx)
        .into_iter()
        .map(|finding| (finding.code(), finding.message(), finding.location))
        .collect()
}

/// Without its table, the rule tolerates nothing, and `--write-baseline`
/// creates no table: as for an instance, but without instance advice.
#[test]
fn a_rule_without_instances_or_a_table() {
    let ctx = context(
        Baseline::default(),
        &[("a.rs", "x\nhit\nhit\n"), ("b.rs", "x\n")],
    );

    assert_eq!(
        findings(&ctx),
        [(
            "hits.no_crossing".to_owned(),
            "a.rs: 2 hits".to_owned(),
            Location {
                path: "a.rs".to_owned(),
                line: 2,
            },
        )]
    );
    let mut written = Baseline::default();
    let not_added: Vec<String> = Rule::update_baseline(&Hits, &ctx, &mut written)
        .into_iter()
        .map(|entry| entry.line)
        .collect();
    assert_eq!(
        not_added,
        [
            "not added: a.rs (2 hits); architecture-baseline.toml has no [hits] table; add the \
          table and its entries by hand"
        ]
    );
    assert_eq!(written.table("hits"), None);
}

/// An entry the loaded file has no line for, such as one set in memory, is
/// shown on the baseline's line 1.
#[test]
fn an_entry_without_a_line_points_at_line_1() {
    let mut baseline = Baseline::default();
    baseline.insert_table(
        "hits".to_owned(),
        BTreeMap::from([("gone.rs".to_owned(), 1)]),
    );
    let ctx = context(baseline, &[]);

    assert_eq!(
        findings(&ctx),
        [(
            "hits.stale_entries".to_owned(),
            "gone.rs: listed in [hits] but no longer a production Rust file. Remove the entry; a \
             renamed file is checked under its new path."
                .to_owned(),
            Location {
                path: BASELINE_FILE.to_owned(),
                line: 1,
            },
        )]
    );
}

/// A base copy is never taken to lack the tables of a rule it does not
/// read, which would report every entry as new: their comparisons are
/// skipped, and say so.
#[test]
fn a_base_copy_that_does_not_read_the_rule() {
    let mut baseline = Baseline::default();
    baseline.insert_table("hits".to_owned(), BTreeMap::from([("a.rs".to_owned(), 1)]));
    let mut ctx = context(baseline, &[("a.rs", "hit\n")]);
    let dir = tempfile::tempdir().expect("create a temporary directory");
    let path = dir.path().join("base.toml");
    fs::write(&path, "[file_size]\n").expect("write the base copy");
    ctx.base_baseline = Baseline::load_base(&path).expect("the base copy loads");

    assert_eq!(findings(&ctx), []);
    assert_eq!(
        Rule::skipped(&Hits, &ctx),
        [
            "hits.no_new_entries and hits.no_raised_caps skipped (archcheck does not read these \
          tables from a base baseline)"
        ]
    );
}

/// Each rule's tables are written under its own key, in name order, as
/// `[<rule>]` or as `[<rule>.<instance>]` tables, never both.
#[test]
fn every_rule_s_tables_are_written() {
    let caps = |path: &str| BTreeMap::from([(path.to_owned(), 1)]);
    let mut baseline = Baseline::default();
    baseline.insert_table("hits".to_owned(), caps("a.rs"));
    baseline.insert_table("zz.two".to_owned(), caps("c.rs"));
    baseline.insert_table("zz.one".to_owned(), caps("b.rs"));
    assert_eq!(
        toml::to_string(&baseline).expect("the baseline serializes"),
        "[file_size]\n\n[hits]\n\"a.rs\" = 1\n\n[zz.one]\n\"b.rs\" = 1\n\n[zz.two]\n\"c.rs\" = 1\n"
    );

    baseline.insert_table("hits.three".to_owned(), caps("d.rs"));
    let error = toml::to_string(&baseline).expect_err("[hits] and [hits.three] conflict");
    assert!(
        error
            .to_string()
            .contains("[hits] and [hits.<instance>] tables can't both be written"),
        "{error}"
    );
}
