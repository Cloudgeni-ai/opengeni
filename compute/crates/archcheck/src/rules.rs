// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! The rule interface and the registry every check runs from.

mod file_size;
mod pattern_ratchet;
mod ratchet;

pub(crate) use file_size::FileSize;
pub(crate) use pattern_ratchet::PatternRatchet;
pub(crate) use ratchet::CountRule;

use crate::{baseline::Baseline, config::RulesConfig, context::Context, finding::Finding};

/// A rule reads its `[rules.<name>]` table from `ctx.config` and names
/// itself, and the instance if it has several, in each [`Finding`] it returns.
/// A rule whose baseline tables cap a count per file implements
/// [`ratchet::CountRule`] instead.
pub trait Rule {
    fn check(&self, ctx: &Context) -> Vec<Finding>;

    /// Behaviours this context cannot check, as one line per reason, such as
    /// `file_size.no_new_entries and … skipped (…)`. Not called for a base
    /// branch's copy that is not TOML at all: [`crate::skipped`] reports
    /// that once, from every rule's [`Rule::base_comparisons`].
    fn skipped(&self, _ctx: &Context) -> Vec<String> {
        Vec::new()
    }

    /// The behaviours that compare with the base branch's copy, one phrase
    /// per table, such as `file_size.no_new_entries and
    /// file_size.no_raised_caps`.
    fn base_comparisons(&self, _ctx: &Context) -> Vec<String> {
        Vec::new()
    }

    /// The baseline tables `config` gives this rule, by the name
    /// `--write-baseline=<table>` takes. A table no rule names is a
    /// configuration error.
    fn tables(&self, _config: &RulesConfig) -> Vec<String> {
        Vec::new()
    }

    /// The `<rule>` this rule's baseline tables are named for, if it has any:
    /// [`Baseline::load_base`] must read them from the base branch's copy.
    fn baseline_rule(&self) -> Option<&'static str> {
        None
    }

    /// Fills this rule's tables for `--write-baseline` from the entries in
    /// `ctx.baseline`, and returns each violation it did not add. It never
    /// adds an entry, and a table of a rule with instances that `ctx.baseline`
    /// lacks is not created. Rules without a baseline keep the default.
    fn update_baseline(&self, _ctx: &Context, _baseline: &mut Baseline) -> Vec<NotAdded> {
        Vec::new()
    }
}

/// A violation [`Rule::update_baseline`] found without an entry and did not
/// add.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotAdded {
    /// The table it is missing from, as `--write-baseline=<table>` names it.
    pub table: String,
    /// The entry it would need: its file's path and current count.
    pub path: String,
    pub count: usize,
    /// `not added: …`, with what to do instead.
    pub line: String,
}

/// Every rule's baseline tables, in reporting order.
pub fn tables(config: &RulesConfig) -> Vec<String> {
    registered()
        .iter()
        .flat_map(|rule| rule.tables(config))
        .collect()
}

/// Every rule, in reporting order. Register a new rule here.
pub fn registered() -> Vec<Box<dyn Rule>> {
    vec![Box::new(FileSize), Box::new(PatternRatchet)]
}
