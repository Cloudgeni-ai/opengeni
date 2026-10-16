// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! `ARCHITECTURE.toml`: which rules run, their parameters, and each
//! behaviour's mode.
//!
//! Every table denies unknown keys so a typo or a section for a rule that does
//! not exist is a configuration error rather than a silently skipped check.

use std::{borrow::Borrow, collections::BTreeMap, fmt};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use regex::RegexSet;
use serde::Deserialize;
use thiserror::Error;

pub const CONFIG_FILE: &str = "ARCHITECTURE.toml";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureConfig {
    /// The branch this workspace's changes merge into. `archcheck` compares
    /// the baseline with that branch's copy at the merge base, so a branch
    /// cannot add an entry or raise a cap unnoticed. Without it, those
    /// comparisons need `--base-baseline`.
    #[serde(default)]
    pub base: Option<BaseConfig>,
    pub rules: RulesConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BaseConfig {
    /// A git revision naming the branch, such as `origin/main`.
    pub branch: String,
}

/// One field per rule, named by the rule's id.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulesConfig {
    pub file_size: FileSizeConfig,
    /// `[rules.pattern_ratchet.<instance>]` tables; none when absent.
    #[serde(default)]
    pub pattern_ratchet: BTreeMap<InstanceName, PatternRatchetConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSizeConfig {
    /// Code lines allowed per production Rust file.
    pub limit: usize,
    pub no_crossing: BehaviourConfig,
    pub no_new_entries: BehaviourConfig,
    pub no_raised_caps: BehaviourConfig,
    pub listed_no_growth: BehaviourConfig,
    pub stale_entries: BehaviourConfig,
}

/// One named instance of `pattern_ratchet`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternRatchetConfig {
    /// A code line matching any of these regexes is restricted.
    pub patterns: Patterns,
    /// Repository-relative path globs whose files may match freely.
    pub allow: AllowList,
    pub no_crossing: BehaviourConfig,
    pub no_new_entries: BehaviourConfig,
    pub no_raised_caps: BehaviourConfig,
    pub listed_no_growth: BehaviourConfig,
    pub stale_entries: BehaviourConfig,
}

/// The name of a rule instance, as it appears in finding codes and baseline
/// table names: lowercase ASCII letters, digits and underscores, starting with
/// a letter.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(try_from = "String")]
pub struct InstanceName(String);

#[derive(Debug, Error)]
#[error(
    "instance name {0:?} must be lowercase ASCII letters, digits and underscores, starting with \
     a letter"
)]
pub struct InstanceNameError(String);

impl InstanceName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for InstanceName {
    type Error = InstanceNameError;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        let mut chars = name.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if valid {
            Ok(Self(name))
        } else {
            Err(InstanceNameError(name))
        }
    }
}

impl Borrow<str> for InstanceName {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for InstanceName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Regexes matched against each code line, without its line ending.
#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "Vec<String>")]
pub struct Patterns(RegexSet);

#[derive(Debug, Error)]
pub enum PatternsError {
    #[error("patterns must list at least one regex")]
    Empty,
    #[error(transparent)]
    Regex(#[from] regex::Error),
}

impl Patterns {
    pub fn is_match(&self, line: &str) -> bool {
        self.0.is_match(line)
    }
}

impl TryFrom<Vec<String>> for Patterns {
    type Error = PatternsError;

    fn try_from(patterns: Vec<String>) -> Result<Self, Self::Error> {
        if patterns.is_empty() {
            return Err(PatternsError::Empty);
        }
        Ok(Self(RegexSet::new(patterns)?))
    }
}

/// Globs over repository-relative, `/`-separated paths. `*` and `?` stay
/// within one path component; `**` spans any number of them.
#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "Vec<String>")]
pub struct AllowList(GlobSet);

impl AllowList {
    pub fn is_match(&self, path: &str) -> bool {
        self.0.is_match(path)
    }
}

impl TryFrom<Vec<String>> for AllowList {
    type Error = globset::Error;

    fn try_from(globs: Vec<String>) -> Result<Self, Self::Error> {
        let mut set = GlobSetBuilder::new();
        for glob in globs {
            set.add(GlobBuilder::new(&glob).literal_separator(true).build()?);
        }
        Ok(Self(set.build()?))
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BehaviourConfig {
    pub mode: Mode,
}

/// Whether a behaviour's findings fail the check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Reported, never fails the check.
    Advisory,
    /// Reported and fails the check.
    Required,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Advisory => "advisory",
            Self::Required => "required",
        }
    }

    pub fn is_required(self) -> bool {
        matches!(self, Self::Required)
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
