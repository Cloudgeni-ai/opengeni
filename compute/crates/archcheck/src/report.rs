// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! Rendering findings for people and for reviewdog.

mod rdjson;

use std::str::FromStr;

use thiserror::Error;

use crate::finding::Finding;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Findings grouped by code (`<rule>[.<instance>].<behaviour>`) and mode,
    /// then a one-line summary.
    Human,
    /// One reviewdog Diagnostic Format (rdjson) document.
    Rdjson,
}

#[derive(Debug, Error)]
#[error("unknown format {0:?}; expected human or rdjson")]
pub struct UnknownFormatError(pub String);

impl FromStr for Format {
    type Err = UnknownFormatError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "human" => Ok(Self::Human),
            "rdjson" => Ok(Self::Rdjson),
            other => Err(UnknownFormatError(other.to_owned())),
        }
    }
}

/// `findings` in [`crate::check`] order, which keeps each rule's (or rule
/// instance's) behaviours contiguous.
pub fn render(format: Format, findings: &[Finding], files_checked: usize) -> String {
    match format {
        Format::Human => human(findings, files_checked),
        Format::Rdjson => rdjson::render(findings),
    }
}

fn human(findings: &[Finding], files_checked: usize) -> String {
    let mut out = String::new();
    let mut group = None;
    for finding in findings {
        let key = (finding.code(), finding.mode);
        if group.as_ref() != Some(&key) {
            out.push_str(&format!("{} ({}):\n", key.0, key.1));
            group = Some(key);
        }
        out.push_str(&format!("  {}\n", finding.message()));
    }
    if !findings.is_empty() {
        out.push('\n');
    }
    out.push_str(&summary(findings, files_checked));
    out.push('\n');
    out
}

/// One line, such as `archcheck: 2 findings (2 advisory, 0 required; 1180
/// production Rust files checked)`.
pub fn summary(findings: &[Finding], files_checked: usize) -> String {
    let checked = format!("{files_checked} production Rust files checked");
    if findings.is_empty() {
        return format!("archcheck: no findings ({checked})");
    }
    let required = findings
        .iter()
        .filter(|finding| finding.mode.is_required())
        .count();
    format!(
        "archcheck: {} finding{} ({} advisory, {required} required; {checked})",
        findings.len(),
        if findings.len() == 1 { "" } else { "s" },
        findings.len() - required,
    )
}
