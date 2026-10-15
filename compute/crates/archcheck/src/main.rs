// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! `archcheck`: check repository structure rules declared in `ARCHITECTURE.toml`.
//!
//! Exit status: 0 when no required-mode finding exists, 1 when one does, and 2
//! for configuration, usage or I/O errors.

// As in lib.rs: upstream's style, kept for diffing against SPACE.
#![allow(
    clippy::format_collect,
    clippy::format_push_string,
    clippy::too_many_lines
)]

use std::{
    env,
    ffi::OsString,
    fmt,
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
};

use compute_archcheck::{
    BASELINE_FILE, Baseline, Context, LoadError, WriteBaselineError, check,
    context::find_workspace_root,
    report::{Format, UnknownFormatError, render, summary},
    skipped, write_baseline, write_baseline_table,
};
use thiserror::Error;

const USAGE: &str = "\
usage: archcheck [--root <path>] [--format human|rdjson]
                 [--base-baseline <path>]
       archcheck [--root <path>] --write-baseline[=<table>]

  --root <path>       repository root (default: the Cargo workspace containing
                      the current directory)
  --format <format>   human (default), or rdjson for reviewdog, with the
                      summary on stderr
  --base-baseline <path>
                      the base branch's architecture-baseline.toml, which the
                      no_new_entries and no_raised_caps behaviours compare
                      with (skipped without it)
  --write-baseline[=<table>]
                      update or remove the entries of architecture-baseline.toml
                      to match the current tree, or with =<table> (file_size or
                      pattern_ratchet.<instance>) only that table's, keeping
                      the others. It lists each violation without an entry,
                      with the entries to add by hand, and never adds one";

const EXIT_REQUIRED_FINDINGS: u8 = 1;
const EXIT_ERROR: u8 = 2;

/// A command line that cannot be run; printed with the usage text.
#[derive(Debug, Error)]
enum UsageError {
    #[error("argument {0:?} is not valid UTF-8")]
    NonUtf8Argument(OsString),
    #[error("{0} needs a value")]
    MissingValue(String),
    #[error("unexpected argument {0:?}")]
    UnexpectedArgument(String),
    #[error("unexpected argument {0:?}; name a table as --write-baseline={0}")]
    WriteBaselineTable(String),
    #[error("--base-baseline cannot be combined with --write-baseline")]
    BaseBaselineWithWriteBaseline,
    #[error(transparent)]
    Format(#[from] UnknownFormatError),
}

#[derive(Debug, Error)]
enum RunError {
    #[error("could not read the current directory: {0}")]
    CurrentDir(#[source] io::Error),
    #[error(transparent)]
    Load(#[from] LoadError),
    #[error(transparent)]
    WriteBaseline(#[from] WriteBaselineError),
    #[error("could not list the entries not added: {0}")]
    NotAddedEntries(#[from] toml::ser::Error),
    #[error("could not write the output: {0}")]
    Output(#[source] io::Error),
}

struct Options {
    root: Option<PathBuf>,
    format: Format,
    base_baseline: Option<PathBuf>,
    write_baseline: Option<WriteBaseline>,
}

/// `--write-baseline`, of every table or of the one named.
enum WriteBaseline {
    All,
    Table(String),
}

fn main() -> ExitCode {
    let result = match parse_args(env::args_os().skip(1)) {
        Ok(Some(options)) => run(options),
        Ok(None) => write(io::stdout(), format_args!("{USAGE}\n")).map(|()| ExitCode::SUCCESS),
        Err(err) => {
            report_error(format_args!("archcheck: {err}\n{USAGE}"));
            return ExitCode::from(EXIT_ERROR);
        }
    };
    match result {
        Ok(code) => code,
        Err(err) => {
            report_error(format_args!("archcheck: error: {err}"));
            ExitCode::from(EXIT_ERROR)
        }
    }
}

fn run(options: Options) -> Result<ExitCode, RunError> {
    let root = match options.root {
        Some(root) => root,
        None => find_workspace_root(&env::current_dir().map_err(RunError::CurrentDir)?)?,
    };

    if let Some(scope) = options.write_baseline {
        let (written, tables, kept) = match scope {
            WriteBaseline::All => {
                let written = write_baseline(&root)?;
                let tables = written.baseline.table_names();
                (written, tables, "")
            }
            WriteBaseline::Table(table) => (
                write_baseline_table(&root, &table)?,
                vec![table],
                "; other tables kept",
            ),
        };
        let not_added: String = written
            .not_added
            .iter()
            .map(|line| format!("{line}\n"))
            .collect();
        let path = root.join(BASELINE_FILE);
        let counts: Vec<String> = tables
            .iter()
            .filter_map(|table| {
                let entries = written.baseline.table(table)?.len();
                Some(format!("{entries} {table}"))
            })
            .collect();
        let wrote = match tables.as_slice() {
            [table] if counts.is_empty() => format!(
                "archcheck: {} has no [{table}] table, which only a hand edit adds; left it alone",
                path.display()
            ),
            _ => format!(
                "archcheck: wrote {} entries to {}{kept}",
                counts.join(", "),
                path.display()
            ),
        };
        // Pasted inside its table, an entry is a deliberate exception, which
        // no_new_entries reports on the pull request.
        let entries = if written.not_added_entries.is_empty() {
            String::new()
        } else {
            format!(
                "archcheck: the entries not added, for a deliberate exception added by hand \
                 (no_new_entries reports it):\n{}",
                written.not_added_toml()?
            )
        };
        write(io::stdout(), format_args!("{not_added}{wrote}\n{entries}"))?;
        return Ok(ExitCode::SUCCESS);
    }

    let mut ctx = Context::load(&root)?;
    if let Some(path) = &options.base_baseline {
        ctx.base_baseline = Baseline::load_base(path)?;
    }
    let findings = check(&ctx);
    let report = render(options.format, &findings, ctx.files.len());
    // A line per skip, or warning about a skip, after the summary line.
    let skipped: String = skipped(&ctx)
        .iter()
        .map(|line| format!("archcheck: {line}\n"))
        .collect();
    if options.format == Format::Rdjson {
        // stdout holds only the document.
        write(io::stdout(), format_args!("{report}"))?;
        let summary = summary(&findings, ctx.files.len());
        write(io::stderr(), format_args!("{summary}\n{skipped}"))?;
    } else {
        write(io::stdout(), format_args!("{report}{skipped}"))?;
    }
    if findings.iter().any(|finding| finding.mode.is_required()) {
        Ok(ExitCode::from(EXIT_REQUIRED_FINDINGS))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

/// Writes and flushes, so a full disk or a closed pipe exits 2 rather than
/// panicking in `print!` or being lost when stdout is flushed at exit.
fn write(mut out: impl Write, text: fmt::Arguments<'_>) -> Result<(), RunError> {
    out.write_fmt(text)
        .and_then(|()| out.flush())
        .map_err(RunError::Output)
}

/// An error message for stderr. If stderr cannot be written either, the exit
/// status is all that is left to report it.
fn report_error(message: fmt::Arguments<'_>) {
    let _ = writeln!(io::stderr(), "{message}");
}

/// `Ok(None)` asks for help.
fn parse_args(args: impl Iterator<Item = OsString>) -> Result<Option<Options>, UsageError> {
    let mut options = Options {
        root: None,
        format: Format::Human,
        base_baseline: None,
        write_baseline: None,
    };
    let mut args = args
        .map(|arg| arg.into_string().map_err(UsageError::NonUtf8Argument))
        .peekable();
    while let Some(arg) = args.next() {
        let arg = arg?;
        let (flag, inline_value) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag.to_owned(), Some(value.into())),
            _ => (arg, None),
        };
        let mut value = || match inline_value.clone() {
            Some(value) => Ok(value),
            None => args
                .next()
                .unwrap_or_else(|| Err(UsageError::MissingValue(flag.clone()))),
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--root" => options.root = Some(PathBuf::from(value()?)),
            "--format" => options.format = value()?.parse()?,
            "--base-baseline" => options.base_baseline = Some(PathBuf::from(value()?)),
            // A table is only ever given after `=`, so a following argument
            // is never taken as one; after a bare `--write-baseline`, the
            // error says how to name it.
            "--write-baseline" => {
                if inline_value.is_none()
                    && let Some(Ok(next)) =
                        args.next_if(|arg| arg.as_ref().is_ok_and(|arg| !arg.starts_with('-')))
                {
                    return Err(UsageError::WriteBaselineTable(next));
                }
                options.write_baseline =
                    Some(inline_value.map_or(WriteBaseline::All, WriteBaseline::Table));
            }
            other => return Err(UsageError::UnexpectedArgument(other.to_owned())),
        }
    }
    if options.write_baseline.is_some() && options.base_baseline.is_some() {
        return Err(UsageError::BaseBaselineWithWriteBaseline);
    }
    Ok(Some(options))
}
