// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! A code-line limit on production Rust files.
//!
//! A file over the limit violates it, and the `[file_size]` baseline table
//! caps each listed file's code lines; [`super::ratchet`] has the
//! behaviours.

use crate::{
    baseline::BASELINE_FILE,
    config::{FileSizeConfig, RulesConfig},
    context::ProductionFile,
    rules::ratchet::{Count, CountRatchet, CountRule, Modes, Wording},
};

pub struct FileSize;

impl CountRule for FileSize {
    const NAME: &'static str = "file_size";

    fn ratchets<'a>(&self, config: &'a RulesConfig) -> Vec<Box<dyn CountRatchet + 'a>> {
        vec![Box::new(Limit(&config.file_size))]
    }
}

struct Limit<'a>(&'a FileSizeConfig);

impl CountRatchet for Limit<'_> {
    fn modes(&self) -> Modes {
        let config = self.0;
        Modes {
            no_crossing: config.no_crossing.mode,
            no_new_entries: config.no_new_entries.mode,
            no_raised_caps: config.no_raised_caps.mode,
            listed_no_growth: config.listed_no_growth.mode,
            stale_entries: config.stale_entries.mode,
        }
    }

    /// Whole-file findings are shown on line 1.
    fn measure(&self, file: &ProductionFile) -> Option<Count> {
        (file.code_lines > self.0.limit).then_some(Count {
            count: file.code_lines,
            first_line: 1,
        })
    }

    fn wording(&self) -> Wording {
        Wording {
            place: BASELINE_FILE.to_owned(),
            violators: format!("files over the {}-line limit", thousands(self.0.limit)),
            fix: "Split the file".to_owned(),
            unit: "code lines".to_owned(),
            growth_fix: "split the file before adding to it".to_owned(),
            not_added_fix: "split it".to_owned(),
        }
    }

    fn crossing(&self, count: Count) -> String {
        format!(
            ": {} code lines, over the {}-line limit (comments and blank lines are not counted). \
             Split it into submodules by responsibility.",
            count.count,
            thousands(self.0.limit),
        )
    }

    fn cleared(&self, file: &ProductionFile) -> String {
        format!(
            " is down to {} code lines, within the {}-line limit",
            file.code_lines,
            thousands(self.0.limit),
        )
    }

    fn counted(&self, count: usize) -> String {
        format!("{count} code lines")
    }
}

/// `1000` as `1,000`.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}
