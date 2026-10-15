// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! Per-file ratchets on code lines that match a set of patterns.
//!
//! Each `[rules.pattern_ratchet.<instance>]` restricts code lines matching
//! any of its `patterns` to the files its `allow` globs match: a file outside
//! them with a matching line violates it, and the instance's own
//! `[pattern_ratchet.<instance>]` baseline table caps each listed file's
//! matching lines; [`super::ratchet`] has the behaviours. Instances are
//! independent: each reads only its own configuration and tables.

use crate::{
    baseline::BASELINE_FILE,
    config::{InstanceName, PatternRatchetConfig, RulesConfig},
    context::{ProductionFile, code_lines},
    rules::ratchet::{Count, CountRatchet, CountRule, Modes, NO_NEW_ENTRIES, Wording},
};

pub struct PatternRatchet;

const RULE: &str = "pattern_ratchet";

impl CountRule for PatternRatchet {
    const NAME: &'static str = RULE;

    fn ratchets<'a>(&self, config: &'a RulesConfig) -> Vec<Box<dyn CountRatchet + 'a>> {
        config
            .pattern_ratchet
            .iter()
            .map(|(instance, config)| {
                Box::new(Instance { instance, config }) as Box<dyn CountRatchet + 'a>
            })
            .collect()
    }
}

struct Instance<'a> {
    instance: &'a InstanceName,
    config: &'a PatternRatchetConfig,
}

impl Instance<'_> {
    /// The instance's baseline table and where it is.
    fn table(&self) -> String {
        format!("[{RULE}.{}] in {BASELINE_FILE}", self.instance)
    }
}

impl CountRatchet for Instance<'_> {
    fn instance(&self) -> Option<&str> {
        Some(self.instance.as_str())
    }

    fn modes(&self) -> Modes {
        let config = self.config;
        Modes {
            no_crossing: config.no_crossing.mode,
            no_new_entries: config.no_new_entries.mode,
            no_raised_caps: config.no_raised_caps.mode,
            listed_no_growth: config.listed_no_growth.mode,
            stale_entries: config.stale_entries.mode,
        }
    }

    /// `file`'s code lines that match the patterns, unless its path is
    /// allowed or none do. Findings about them are shown on the first.
    fn measure(&self, file: &ProductionFile) -> Option<Count> {
        if self.config.allow.is_match(&file.path) {
            return None;
        }
        let mut lines = code_lines(&file.text)
            .filter(|(_, line)| self.config.patterns.is_match(line))
            .map(|(number, _)| number);
        let first_line = lines.next()?;
        Some(Count {
            count: 1 + lines.count(),
            first_line,
        })
    }

    fn wording(&self) -> Wording {
        let instance = self.instance;
        Wording {
            place: self.table(),
            violators: format!(
                "files outside the paths [rules.{RULE}.{instance}] in ARCHITECTURE.toml allows"
            ),
            fix: "Move that code behind an allowed path".to_owned(),
            unit: format!("code lines matching the {instance} patterns"),
            growth_fix: "move new matches behind an allowed path".to_owned(),
            not_added_fix: "move them behind an allowed path".to_owned(),
        }
    }

    fn crossing(&self, count: Count) -> String {
        let instance = self.instance;
        format!(
            ": {} the {instance} patterns, first on line {}, outside the paths \
             [rules.{RULE}.{instance}] in ARCHITECTURE.toml allows. Move that code behind an \
             allowed path. If the file was renamed, move its entry in {} to the new path; \
             {NO_NEW_ENTRIES} reports the moved entry as new, for a reviewer to accept.",
            match_count(count.count),
            count.first_line,
            self.table(),
        )
    }

    fn cleared(&self, _file: &ProductionFile) -> String {
        format!(
            " has no code lines left matching the {} patterns outside its allowed paths",
            self.instance
        )
    }

    fn counted(&self, count: usize) -> String {
        format!(
            "{} matching the {} patterns",
            code_lines_text(count),
            self.instance
        )
    }
}

/// `1 code line matches` or `2 code lines match`.
fn match_count(count: usize) -> String {
    if count == 1 {
        "1 code line matches".to_owned()
    } else {
        format!("{count} code lines match")
    }
}

/// `1 code line` or `2 code lines`.
fn code_lines_text(count: usize) -> String {
    if count == 1 {
        "1 code line".to_owned()
    } else {
        format!("{count} code lines")
    }
}
