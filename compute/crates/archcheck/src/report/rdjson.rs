// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! reviewdog's Diagnostic Format, which reviewdog filters to the files a pull
//! request changes and reports as annotations.
//!
//! Paths are written exactly as they are, so that they match the pull
//! request's diff.

use serde::Serialize;

use crate::{config::Mode, finding::Finding};

/// The tool name reviewdog shows with each annotation.
const SOURCE: &str = "archcheck";

#[derive(Serialize)]
struct DiagnosticResult<'a> {
    source: Source,
    diagnostics: Vec<Diagnostic<'a>>,
}

#[derive(Serialize)]
struct Source {
    name: &'static str,
}

#[derive(Serialize)]
struct Diagnostic<'a> {
    message: String,
    location: Location<'a>,
    severity: &'static str,
    code: Code,
}

#[derive(Serialize)]
struct Location<'a> {
    path: &'a str,
    range: Range,
}

#[derive(Serialize)]
struct Range {
    start: Position,
}

#[derive(Serialize)]
struct Position {
    line: usize,
}

#[derive(Serialize)]
struct Code {
    value: String,
}

/// One document with a diagnostic per finding: `ERROR` for a required-mode
/// finding and `WARNING` for an advisory one, so `reviewdog -fail-level=error`
/// fails on required findings only.
pub fn render(findings: &[Finding]) -> String {
    let result = DiagnosticResult {
        source: Source { name: SOURCE },
        diagnostics: findings
            .iter()
            .map(|finding| Diagnostic {
                message: finding.message(),
                location: Location {
                    path: &finding.location.path,
                    range: Range {
                        start: Position {
                            line: finding.location.line,
                        },
                    },
                },
                severity: match finding.mode {
                    Mode::Advisory => "WARNING",
                    Mode::Required => "ERROR",
                },
                code: Code {
                    value: finding.code(),
                },
            })
            .collect(),
    };
    let mut out = serde_json::to_string(&result)
        .expect("structs of strings and integers always serialize to JSON");
    out.push('\n');
    out
}
