//! The base branch's baseline, read from git at the merge base with `HEAD`.
//!
//! Comparing with the merge base rather than the branch's tip means a cap the
//! base branch lowered after this branch forked is not mistaken for one this
//! branch raised. A base without a baseline file tolerates nothing, so every
//! entry counts as new.

use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

use thiserror::Error;

use crate::{
    BASELINE_FILE,
    baseline::{BaseBaseline, Baseline},
    context::LoadError,
};

#[derive(Debug, Error)]
pub enum GitBaseError {
    #[error("could not run git: {0}")]
    Run(#[source] std::io::Error),
    #[error(
        "no merge base with {branch} ({detail}); fetch it, pass --base-baseline <path>, or skip \
         the comparison with --no-base"
    )]
    MergeBase { branch: String, detail: String },
    #[error("could not read {BASELINE_FILE} at {revision}: {detail}")]
    Show { revision: String, detail: String },
    #[error(transparent)]
    Load(#[from] LoadError),
}

/// The baseline of `branch` at its merge base with `HEAD`, for the repository
/// holding `root`.
pub fn base_baseline_from_git(root: &Path, branch: &str) -> Result<BaseBaseline, GitBaseError> {
    let merge_base = git(root, &["merge-base", "HEAD", branch])?;
    if !merge_base.status.success() {
        return Err(GitBaseError::MergeBase {
            branch: branch.to_owned(),
            detail: stderr(&merge_base),
        });
    }
    let revision = String::from_utf8_lossy(&merge_base.stdout)
        .trim()
        .to_owned();
    // `./` makes the path relative to `root`, wherever it sits in the repository.
    let object = format!("{revision}:./{BASELINE_FILE}");
    let origin = PathBuf::from(format!("{branch} at {revision}: {BASELINE_FILE}"));
    if !git(root, &["cat-file", "-e", &object])?.status.success() {
        return Ok(Baseline::parse_base("", &origin)?);
    }
    let shown = git(root, &["show", &object])?;
    if !shown.status.success() {
        return Err(GitBaseError::Show {
            revision,
            detail: stderr(&shown),
        });
    }
    let text = String::from_utf8(shown.stdout).map_err(|error| GitBaseError::Show {
        revision: revision.clone(),
        detail: error.to_string(),
    })?;
    Ok(Baseline::parse_base(&text, &origin)?)
}

fn git(root: &Path, args: &[&str]) -> Result<Output, GitBaseError> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(GitBaseError::Run)
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn run(root: &Path, args: &[&str]) {
        let output = git(root, args).expect("git runs");
        assert!(output.status.success(), "git {args:?}: {}", stderr(&output));
    }

    /// A repository whose `compute/` holds the baseline, with one commit on
    /// `base` and `HEAD` one commit ahead of it.
    fn repository(baseline: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let root = dir.path();
        let workspace = root.join("compute");
        fs::create_dir_all(&workspace).expect("the workspace directory");
        run(root, &["init", "-q", "-b", "work"]);
        run(root, &["config", "user.name", "archcheck"]);
        run(root, &["config", "user.email", "archcheck@example.invalid"]);
        fs::write(workspace.join("README"), "base\n").expect("a file");
        if let Some(text) = baseline {
            fs::write(workspace.join(BASELINE_FILE), text).expect("the baseline");
        }
        run(root, &["add", "-A"]);
        run(root, &["commit", "-q", "-m", "base"]);
        run(root, &["branch", "base"]);
        fs::write(
            workspace.join(BASELINE_FILE),
            "[file_size]\n\"later.rs\" = 9\n",
        )
        .expect("the branch's baseline");
        run(root, &["add", "-A"]);
        run(root, &["commit", "-q", "-m", "work"]);
        dir
    }

    #[test]
    fn the_base_copy_is_read_at_the_merge_base() {
        let dir = repository(Some("[file_size]\n\"a.rs\" = 7\n"));
        let base = base_baseline_from_git(&dir.path().join("compute"), "base").expect("read");
        let table = base.table("file_size").expect("a usable table");
        assert_eq!(
            table,
            &std::collections::BTreeMap::from([("a.rs".to_owned(), 7)])
        );
    }

    #[test]
    fn a_base_without_a_baseline_tolerates_nothing() {
        let dir = repository(None);
        let base = base_baseline_from_git(&dir.path().join("compute"), "base").expect("read");
        assert!(base.table("file_size").expect("a usable table").is_empty());
    }

    #[test]
    fn an_unknown_branch_is_an_error_not_a_skip() {
        let dir = repository(None);
        let error = base_baseline_from_git(&dir.path().join("compute"), "missing")
            .expect_err("no such branch");
        assert!(matches!(error, GitBaseError::MergeBase { .. }), "{error}");
        assert!(error.to_string().contains("--no-base"), "{error}");
    }
}
