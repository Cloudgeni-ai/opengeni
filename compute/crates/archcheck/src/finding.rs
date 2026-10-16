// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
use crate::config::Mode;

/// One reported problem. `path` is repository-relative with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    /// The instance of a rule configured as several named instances.
    pub instance: Option<String>,
    pub behaviour: &'static str,
    pub path: String,
    /// The rest of the message after the path, such as `": 1200 code lines…"`.
    pub detail: String,
    pub mode: Mode,
    /// Where a pull request shows the finding.
    pub location: Location,
}

/// A repository-relative file and a 1-based line in it: the line a finding is
/// about, line 1 of its file when it is about the whole file, or, for a
/// finding about a baseline entry itself, the entry's line in the baseline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub path: String,
    pub line: usize,
}

impl Finding {
    /// `<rule>.<behaviour>`, or `<rule>.<instance>.<behaviour>`.
    pub fn code(&self) -> String {
        match &self.instance {
            Some(instance) => format!("{}.{instance}.{}", self.rule, self.behaviour),
            None => format!("{}.{}", self.rule, self.behaviour),
        }
    }

    /// The path followed by the detail, as one sentence.
    pub fn message(&self) -> String {
        format!("{}{}", self.path, self.detail)
    }
}
