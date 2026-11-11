// Derived from SPACE's archcheck (https://github.com/perplexityai/SPACE, Apache-2.0,
// Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
//! archcheck over temporary workspaces: the library for counting, the
//! inventory, findings and the baseline; the binary for modes, exit codes,
//! formats and arguments.

// As in lib.rs: upstream's style, kept for diffing against SPACE.
#![allow(
    clippy::doc_markdown,
    clippy::format_collect,
    clippy::format_push_string,
    clippy::items_after_statements,
    clippy::redundant_closure_for_method_calls,
    clippy::too_many_lines
)]

use std::{fs, path::Path, process::Command};

use compute_archcheck::{
    BaseBaseline, Baseline, Context, check,
    context::count_code_lines,
    report::{Format, render},
    skipped, write_baseline,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const LIMIT: usize = 5;

/// A file of `lines` code lines.
fn code(lines: usize) -> String {
    "let x = 1;\n".repeat(lines)
}

const ADVISORY: [&str; 5] = ["advisory"; 5];

/// The summary's line when no base baseline is given.
const SKIPPED: &str = "archcheck: file_size.no_new_entries and file_size.no_raised_caps skipped \
                       (--no-base given, or no [base] branch in ARCHITECTURE.toml and no --base-baseline)\n";

/// `modes` of no_crossing, no_new_entries, no_raised_caps, listed_no_growth
/// and stale_entries.
fn config(modes: [&str; 5]) -> String {
    let [
        no_crossing,
        no_new_entries,
        no_raised_caps,
        listed_no_growth,
        stale_entries,
    ] = modes;
    format!(
        "[rules.file_size]\nlimit = {LIMIT}\n\
         [rules.file_size.no_crossing]\nmode = \"{no_crossing}\"\n\
         [rules.file_size.no_new_entries]\nmode = \"{no_new_entries}\"\n\
         [rules.file_size.no_raised_caps]\nmode = \"{no_raised_caps}\"\n\
         [rules.file_size.listed_no_growth]\nmode = \"{listed_no_growth}\"\n\
         [rules.file_size.stale_entries]\nmode = \"{stale_entries}\"\n"
    )
}

fn baseline(entries: &[(&str, usize)]) -> String {
    let mut text = String::from("[file_size]\n");
    for (path, cap) in entries {
        text.push_str(&format!("{path:?} = {cap}\n"));
    }
    text
}

/// A workspace with members `crates/a` and `crates/b`, every behaviour
/// advisory and an empty baseline, with `files` written over those defaults.
fn workspace(files: &[(&str, String)]) -> TempDir {
    let dir = tempfile::tempdir().expect("create a temporary workspace");
    let defaults = [
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/a\", \"crates/b\"]\n".to_owned(),
        ),
        ("crates/a/Cargo.toml", "[package]\n".to_owned()),
        ("crates/b/Cargo.toml", "[package]\n".to_owned()),
        ("ARCHITECTURE.toml", config(ADVISORY)),
        ("architecture-baseline.toml", baseline(&[])),
    ];
    for (path, contents) in defaults.iter().chain(files) {
        let path = dir.path().join(path);
        fs::create_dir_all(path.parent().expect("a parent directory")).expect("create it");
        fs::write(&path, contents).expect("write a workspace file");
    }
    dir
}

/// The workspace's context, with `base` written to `base-baseline.toml` and
/// read as the base branch's baseline.
fn load(root: &Path, base: Option<&str>) -> Context {
    let mut ctx = Context::load(root).expect("the workspace loads");
    if let Some(text) = base {
        let path = root.join("base-baseline.toml");
        fs::write(&path, text).expect("write the base baseline");
        ctx.base_baseline = Baseline::load_base(&path).expect("the base baseline is readable");
    }
    ctx
}

/// `(behaviour, message)` of every finding, in reporting order.
fn findings(root: &Path) -> Vec<(&'static str, String)> {
    findings_against(root, None)
}

fn findings_against(root: &Path, base: Option<&str>) -> Vec<(&'static str, String)> {
    check(&load(root, base))
        .into_iter()
        .map(|finding| (finding.behaviour, finding.message()))
        .collect()
}

fn rdjson(root: &Path, base: Option<&str>) -> Value {
    let ctx = load(root, base);
    let text = render(Format::Rdjson, &check(&ctx), ctx.files.len());
    serde_json::from_str(&text).expect("one JSON document")
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(root: &Path, args: &[&str]) -> Run {
    let output = Command::new(env!("CARGO_BIN_EXE_archcheck"))
        .arg("--root")
        .arg(root)
        .args(args)
        .output()
        .expect("run archcheck");
    Run {
        code: output.status.code().expect("an exit status"),
        stdout: String::from_utf8(output.stdout).expect("UTF-8 stdout"),
        stderr: String::from_utf8(output.stderr).expect("UTF-8 stderr"),
    }
}

#[test]
fn counting() {
    let cases: &[(&str, &str, usize)] = &[
        ("statements", "let a = 1;\nlet b = 2;\n", 2),
        (
            "comments and blank lines are free",
            "// c\n/// d\n//! e\n\n   \n\tfn f() {}\n",
            1,
        ),
        (
            "block comments and attributes count",
            "/* c */\n#[test]\nfn f() {}\n",
            3,
        ),
        ("a byte order mark", "\u{feff}// c\nfn f() {}\n", 1),
        ("CRLF", "// c\r\nfn f() {}\r\n", 1),
        ("a lone CR ends no comment", "// c\rfn f() {}", 0),
        ("a CR-only file is one line", "fn f() {}\rfn g() {}\r", 1),
        ("U+2028 ends no comment", "// c\u{2028}fn f() {}", 0),
        ("U+2029 ends no comment", "// c\u{2029}fn f() {}", 0),
    ];
    for (name, text, expected) in cases {
        assert_eq!(count_code_lines(text), *expected, "{name}");
    }
}

#[test]
fn inventory() {
    let cases: &[(&str, bool)] = &[
        ("crates/a/src/lib.rs", true),
        ("crates/a/src/attests.rs", true),
        ("crates/a/src/testsuite/mod.rs", true),
        ("crates/b/src/deep/nested.rs", true),
        ("crates/a/src/tests.rs", false),
        ("crates/a/src/foo_tests.rs", false),
        ("crates/a/src/m/tests/mod.rs", false),
        ("crates/a/src/m/tests/deep/x.rs", false),
        ("crates/a/src/notes.txt", false),
        ("crates/a/tests/it.rs", false),
        ("crates/a/build.rs", false),
        ("crates/c/src/lib.rs", false),
        // A member inside another member's `src/` is listed once.
        ("crates/a/src/inner/src/lib.rs", true),
    ];
    let mut files: Vec<(&str, String)> = cases.iter().map(|(path, _)| (*path, code(1))).collect();
    files.extend([
        ("crates/a/src/inner/Cargo.toml", "[package]\n".to_owned()),
        ("crates/c/Cargo.toml", "[package]\n".to_owned()),
    ]);
    let mut members = vec!["crates/a", "crates/b", "crates/a/src/inner"];
    let mut expected: Vec<&str> = cases
        .iter()
        .filter(|(_, checked)| *checked)
        .map(|(path, _)| *path)
        .collect();
    #[cfg(unix)]
    {
        // `crates/s/src` is a symlink to `shared/src`, made below.
        files.extend([
            ("crates/s/Cargo.toml", "[package]\n".to_owned()),
            ("shared/src/lib.rs", code(1)),
        ]);
        members.push("crates/s");
        expected.push("crates/s/src/lib.rs");
    }
    files.push((
        "Cargo.toml",
        format!("[workspace]\nmembers = {members:?}\n"),
    ));
    let ws = workspace(&files);
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        // Symlinks below `src/` are skipped, to files and to directories; a
        // member's `src` that is a symlink is followed.
        symlink("lib.rs", ws.path().join("crates/a/src/link.rs")).unwrap();
        symlink("deep", ws.path().join("crates/b/src/linked")).unwrap();
        symlink("../../shared/src", ws.path().join("crates/s/src")).unwrap();
    }
    // Only `.rs` names must be UTF-8. macOS file systems refuse other names.
    #[cfg(target_os = "linux")]
    {
        use std::{ffi::OsStr, os::unix::ffi::OsStrExt};

        let src = ws.path().join("crates/b/src");
        fs::write(src.join(OsStr::from_bytes(b"\xff.txt")), "").unwrap();
    }

    let ctx = Context::load(ws.path()).unwrap();

    let checked: Vec<&str> = ctx.files.iter().map(|file| file.path.as_str()).collect();
    expected.sort_unstable();
    assert_eq!(checked, expected);
}

/// One row per situation: the base branch's baseline entries (`None`
/// without `--base-baseline`), baseline entries, file sizes, and the expected
/// `(behaviour, start of message)` of each finding.
#[test]
fn behaviours() {
    const LISTED: &str = "crates/a/src/listed.rs";
    const NEW: &str = "crates/b/src/new.rs";
    type Sizes<'a> = &'a [(&'a str, usize)];
    type Case<'a> = (
        &'a str,
        Option<Sizes<'a>>,
        Sizes<'a>,
        Sizes<'a>,
        &'a [(&'a str, &'a str)],
    );
    let cases: &[Case] = &[
        (
            "a new file over the limit",
            None,
            &[],
            &[(NEW, LIMIT + 1)],
            &[(
                "no_crossing",
                "crates/b/src/new.rs: 6 code lines, over the 5-line limit (blank lines and // \
                 comments are not counted; block comments and inline test modules are). Split it \
                 into submodules by responsibility.",
            )],
        ),
        ("a new file at the limit", None, &[], &[(NEW, LIMIT)], &[]),
        (
            "a listed file grew",
            None,
            &[(LISTED, 6)],
            &[(LISTED, 7)],
            &[(
                "listed_no_growth",
                "crates/a/src/listed.rs grew from 6 to 7 code lines. Once this rule is \
                 required, split the file before adding to it.",
            )],
        ),
        (
            "a listed file at its cap",
            None,
            &[(LISTED, 6)],
            &[(LISTED, 6)],
            &[],
        ),
        (
            "a listed file shrank",
            None,
            &[(LISTED, 8)],
            &[(LISTED, 7)],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs shrank from 8 to 7 code lines. Lower its cap in \
                 architecture-baseline.toml to 7.",
            )],
        ),
        (
            "a listed file fell to the limit",
            None,
            &[(LISTED, 8)],
            &[(LISTED, LIMIT)],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs is down to 5 code lines, within the 5-line limit. \
                 Remove it from architecture-baseline.toml.",
            )],
        ),
        (
            "a listed file is gone",
            None,
            &[(LISTED, 8)],
            &[],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs: listed in architecture-baseline.toml but no longer a \
                 production Rust file. Remove the entry; a renamed file is checked under its new \
                 path.",
            )],
        ),
        (
            "a listed file was renamed",
            None,
            &[(LISTED, 8)],
            &[(NEW, 8)],
            &[
                ("no_crossing", "crates/b/src/new.rs: 8 code lines, over"),
                ("stale_entries", "crates/a/src/listed.rs: listed in"),
            ],
        ),
        (
            "a key that names no production file",
            None,
            &[("./crates/a/src/listed.rs", 8)],
            &[(LISTED, 8)],
            &[
                ("no_crossing", "crates/a/src/listed.rs: 8 code lines, over"),
                ("stale_entries", "./crates/a/src/listed.rs: listed in"),
            ],
        ),
        (
            "an entry was added",
            Some(&[]),
            &[(NEW, 6)],
            &[(NEW, 6)],
            &[(
                "no_new_entries",
                "crates/b/src/new.rs is in architecture-baseline.toml but not in the base branch's \
                 copy; files over the 5-line limit can't be added (a renamed file counts as \
                 added). Split the file instead.",
            )],
        ),
        (
            "an entry was added without --base-baseline",
            None,
            &[(NEW, 6)],
            &[(NEW, 6)],
            &[],
        ),
        (
            "a listed file was renamed and its entry with it",
            Some(&[(LISTED, 8)]),
            &[(NEW, 8)],
            &[(NEW, 8)],
            &[(
                "no_new_entries",
                "crates/b/src/new.rs is in architecture-baseline.toml but",
            )],
        ),
        (
            "an entry was removed",
            Some(&[(LISTED, 8), (NEW, 6)]),
            &[(NEW, 6)],
            &[(LISTED, LIMIT), (NEW, 6)],
            &[],
        ),
        (
            "a cap was lowered",
            Some(&[(LISTED, 8)]),
            &[(LISTED, 7)],
            &[(LISTED, 7)],
            &[],
        ),
        (
            "a cap was raised",
            Some(&[(LISTED, 6)]),
            &[(LISTED, 7)],
            &[(LISTED, 7)],
            &[(
                "no_raised_caps",
                "crates/a/src/listed.rs: cap raised from 6 to 7 in architecture-baseline.toml; \
                 caps should only go down. Split the file instead.",
            )],
        ),
        (
            "an entry was added and a cap raised",
            Some(&[(LISTED, 6)]),
            &[(LISTED, 7), (NEW, 6)],
            &[(LISTED, 7), (NEW, 6)],
            &[
                ("no_new_entries", "crates/b/src/new.rs is in"),
                (
                    "no_raised_caps",
                    "crates/a/src/listed.rs: cap raised from 6 to 7",
                ),
            ],
        ),
        (
            "a cap was raised without --base-baseline",
            None,
            &[(LISTED, 7)],
            &[(LISTED, 7)],
            &[],
        ),
        (
            "a cap was lowered and another entry removed",
            Some(&[(LISTED, 8), (NEW, 9)]),
            &[(LISTED, 7)],
            &[(LISTED, 7), (NEW, LIMIT)],
            &[],
        ),
    ];
    for (name, base, entries, sizes, expected) in cases {
        let mut files: Vec<(&str, String)> = sizes
            .iter()
            .map(|(path, lines)| (*path, code(*lines)))
            .collect();
        files.push(("architecture-baseline.toml", baseline(entries)));
        let ws = workspace(&files);

        let found = findings_against(ws.path(), base.map(baseline).as_deref());

        assert_eq!(found.len(), expected.len(), "{name}: {found:#?}");
        for ((behaviour, message), (want_behaviour, want_message)) in found.iter().zip(*expected) {
            assert_eq!(behaviour, want_behaviour, "{name}");
            assert!(message.starts_with(want_message), "{name}: {message}");
        }
    }
}

/// The base branch's copy is read leniently: only `[file_size]` matters, and
/// a copy that does not parse skips the comparison with a one-line warning.
/// The baseline lists `crates/a/src/listed.rs` (cap 8) and `crates/b/src/new.rs`.
#[test]
fn lenient_base_baseline() {
    let cases: &[(&str, &str, &[&str], Option<&str>)] = &[
        (
            "an unknown table and key",
            "version = 2\n[file_size]\n\"crates/a/src/listed.rs\" = 8\n[crate_names]\nx = \"y\"\n",
            &["no_new_entries"],
            None,
        ),
        (
            "no [file_size] table",
            "[crate_names]\n",
            &["no_new_entries", "no_new_entries"],
            None,
        ),
        (
            "an empty file",
            "",
            &["no_new_entries", "no_new_entries"],
            None,
        ),
        ("invalid TOML", "[file_size\n", &[], Some("at line 1")),
        (
            "a non-integer cap",
            "[file_size]\n\"crates/a/src/listed.rs\" = 8\n\"crates/b/src/new.rs\" = \"9\"\n",
            &[],
            Some("at line 3"),
        ),
        (
            "a negative cap",
            "[file_size]\n\"x\" = -1\n",
            &[],
            Some("at line 2"),
        ),
        (
            "[file_size] is not a table",
            "file_size = 3\n",
            &[],
            Some("at line 1"),
        ),
    ];
    for (name, base, expected, problem) in cases {
        let ws = workspace(&[
            (
                "architecture-baseline.toml",
                baseline(&[("crates/a/src/listed.rs", 8), ("crates/b/src/new.rs", 6)]),
            ),
            ("crates/a/src/listed.rs", code(8)),
            ("crates/b/src/new.rs", code(6)),
        ]);

        let ctx = load(ws.path(), Some(base));

        let found: Vec<_> = check(&ctx)
            .iter()
            .map(|finding| finding.behaviour)
            .collect();
        assert_eq!(found, *expected, "{name}");
        let skipped = skipped(&ctx);
        match problem {
            None => {
                assert!(
                    matches!(ctx.base_baseline, BaseBaseline::Loaded(_)),
                    "{name}"
                );
                assert_eq!(skipped, Vec::<String>::new(), "{name}");
            }
            Some(at) => {
                let path = ws.path().join("base-baseline.toml");
                let [line] = skipped.as_slice() else {
                    panic!("{name}: {skipped:?}");
                };
                let start = format!("warning: could not parse {} {at}: ", path.display());
                let end = "; file_size.no_new_entries and file_size.no_raised_caps skipped";
                assert!(
                    line.starts_with(&start) && line.ends_with(end) && !line.contains('\n'),
                    "{name}: {line}"
                );
            }
        }
    }
}

/// One finding per behaviour, each reported in its own mode; only required
/// findings exit 1. Without `--base-baseline`, no_new_entries is skipped and
/// the summary says so.
#[test]
fn modes_and_exit_codes() {
    let files = |modes: [&str; 5]| {
        vec![
            ("ARCHITECTURE.toml", config(modes)),
            (
                "architecture-baseline.toml",
                baseline(&[
                    ("crates/a/src/added.rs", 6),
                    ("crates/a/src/gone.rs", 9),
                    ("crates/a/src/grew.rs", 6),
                    ("crates/a/src/raised.rs", 7),
                ]),
            ),
            (
                "base-baseline.toml",
                baseline(&[
                    ("crates/a/src/gone.rs", 9),
                    ("crates/a/src/grew.rs", 6),
                    ("crates/a/src/raised.rs", 6),
                ]),
            ),
            ("crates/a/src/added.rs", code(6)),
            ("crates/a/src/grew.rs", code(7)),
            ("crates/a/src/raised.rs", code(7)),
            ("crates/b/src/new.rs", code(6)),
        ]
    };
    let cases: &[([&str; 5], i32)] = &[(ADVISORY, 0)];
    let required = (0..5).map(|index| {
        let mut modes = ADVISORY;
        modes[index] = "required";
        (modes, 1)
    });
    let cases: Vec<_> = cases.iter().copied().chain(required).collect();
    for (modes, expected) in &cases {
        let ws = workspace(&files(*modes));
        let base = ws.path().join("base-baseline.toml");

        let run = run(ws.path(), &["--base-baseline", base.to_str().unwrap()]);

        assert_eq!(
            run.code, *expected,
            "{modes:?}: {}{}",
            run.stdout, run.stderr
        );
        let headings: Vec<&str> = run
            .stdout
            .lines()
            .filter(|line| line.starts_with("file_size."))
            .collect();
        assert_eq!(
            headings,
            [
                format!("file_size.no_crossing ({}):", modes[0]),
                format!("file_size.no_new_entries ({}):", modes[1]),
                format!("file_size.no_raised_caps ({}):", modes[2]),
                format!("file_size.listed_no_growth ({}):", modes[3]),
                format!("file_size.stale_entries ({}):", modes[4]),
            ],
        );
    }

    let ws = workspace(&files([
        "advisory", "advisory", "advisory", "required", "advisory",
    ]));
    let growth = "crates/a/src/grew.rs grew from 6 to 7 code lines. Split the file before adding \
                  to it.";
    assert!(
        findings(ws.path())
            .iter()
            .any(|(_, message)| message == growth)
    );

    // Without --base-baseline, both are skipped even when required.
    let ws = workspace(&files([
        "advisory", "required", "required", "advisory", "advisory",
    ]));
    let run_without_base = run(ws.path(), &[]);
    assert_eq!(run_without_base.code, 0, "{}", run_without_base.stderr);
    assert!(!run_without_base.stdout.contains("no_new_entries ("));
    assert!(!run_without_base.stdout.contains("no_raised_caps ("));
    assert!(run_without_base.stdout.ends_with(SKIPPED));

    let clean = workspace(&[("ARCHITECTURE.toml", config(["required"; 5]))]);
    let skipped = SKIPPED;
    let summary = "archcheck: no findings (0 production Rust files checked)\n";
    let base = clean.path().join("architecture-baseline.toml");
    for (args, stdout) in [
        (vec![], format!("{summary}{skipped}")),
        (
            vec!["--base-baseline", base.to_str().unwrap()],
            summary.to_owned(),
        ),
    ] {
        let run = run(clean.path(), &args);
        assert_eq!(run.code, 0, "{}", run.stderr);
        assert_eq!(run.stdout, stdout);
    }
}

#[test]
fn human_report() {
    let ws = workspace(&[
        (
            "architecture-baseline.toml",
            baseline(&[("crates/a/src/grew.rs", 6)]),
        ),
        ("crates/a/src/grew.rs", code(7)),
        ("crates/b/src/new.rs", code(6)),
    ]);

    let run = run(ws.path(), &[]);

    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.stdout,
        "file_size.no_crossing (advisory):\n  \
         crates/b/src/new.rs: 6 code lines, over the 5-line limit (blank lines and // comments \
         are not counted; block comments and inline test modules are). Split it into submodules \
         by responsibility.\n\
         file_size.listed_no_growth (advisory):\n  \
         crates/a/src/grew.rs grew from 6 to 7 code lines. Once this rule is required, split \
         the file before adding to it.\n\
         \n\
         archcheck: 2 findings (2 advisory, 0 required; 2 production Rust files checked)\n"
            .to_owned()
            + SKIPPED
    );
}

/// Limits are written with digit grouping; counts are not.
#[test]
fn messages_group_the_limit() {
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            config(ADVISORY).replace("limit = 5", "limit = 1000"),
        ),
        (
            "architecture-baseline.toml",
            baseline(&[("crates/a/src/listed.rs", 1002)]),
        ),
        ("crates/a/src/listed.rs", code(999)),
        ("crates/b/src/new.rs", code(1001)),
    ]);

    assert_eq!(
        findings(ws.path()),
        [
            (
                "no_crossing",
                "crates/b/src/new.rs: 1001 code lines, over the 1,000-line limit (blank lines \
                 and // comments are not counted; block comments and inline test modules are). \
                 Split it into submodules by responsibility."
                    .to_owned()
            ),
            (
                "stale_entries",
                "crates/a/src/listed.rs is down to 999 code lines, within the 1,000-line limit. \
                 Remove it from architecture-baseline.toml."
                    .to_owned()
            ),
        ]
    );
}

/// Each row replaces one file, or removes it with `None`; loading fails with
/// an error that names the file and the problem.
#[test]
fn configuration_errors() {
    const CONFIG: &str = "ARCHITECTURE.toml";
    const BASELINE: &str = "architecture-baseline.toml";
    const MANIFEST: &str = "Cargo.toml";
    let advisory = config(ADVISORY);
    let text = |value: &str| Some(value.to_owned());
    let members = |member: &str| {
        text(&format!(
            "[workspace]\nmembers = [\"crates/a\", {member:?}]\n"
        ))
    };
    let instance = |patterns: &[&str], allow: &[&str]| {
        format!("{advisory}{}", ratchet("old", patterns, allow, ADVISORY))
    };
    let valid_instance = instance(&[r"\bold_table\b"], &["crates/a/**"]);
    let parse = "could not parse";
    let glob = "contains glob characters";
    let unnormalized = "has an empty, `.` or `..` component";
    let cases: &[(&str, &str, Option<String>, &str)] = &[
        (
            "unknown behaviour key",
            CONFIG,
            Some(format!("{advisory}[rules.file_size.no_crossing.extra]\n")),
            parse,
        ),
        (
            "unknown rule key",
            CONFIG,
            Some(advisory.replace("limit = 5", "limit = 5\nlimt = 5")),
            parse,
        ),
        (
            "unknown rule",
            CONFIG,
            Some(format!("{advisory}[rules.crate_names]\n")),
            parse,
        ),
        (
            "unknown mode",
            CONFIG,
            Some(advisory.replacen("advisory", "warn", 1)),
            parse,
        ),
        (
            "missing behaviour",
            CONFIG,
            Some(advisory.replace("[rules.file_size.stale_entries]\nmode = \"advisory\"\n", "")),
            parse,
        ),
        ("unparseable", CONFIG, text("[rules.file_size\n"), parse),
        (
            "bad regex",
            CONFIG,
            Some(instance(&["(old_table"], &[])),
            "regex parse error",
        ),
        (
            "no patterns",
            CONFIG,
            Some(instance(&[], &[])),
            "patterns must list at least one regex",
        ),
        (
            "bad glob",
            CONFIG,
            Some(instance(&["old_table"], &["crates/{a"])),
            "error parsing glob 'crates/{a'",
        ),
        (
            "unknown instance key",
            CONFIG,
            Some(valid_instance.replace("allow = [", "alow = []\nallow = [")),
            "unknown field `alow`",
        ),
        (
            "unknown instance behaviour key",
            CONFIG,
            Some(format!(
                "{valid_instance}[rules.pattern_ratchet.old.no_crossing.extra]\n"
            )),
            parse,
        ),
        (
            "missing instance behaviour",
            CONFIG,
            Some(valid_instance.replace(
                "[rules.pattern_ratchet.old.stale_entries]\nmode = \"advisory\"\n",
                "",
            )),
            "missing field `stale_entries`",
        ),
        (
            "missing patterns",
            CONFIG,
            Some(valid_instance.replace("patterns = ['\\bold_table\\b']\n", "")),
            "missing field `patterns`",
        ),
        (
            "instance name",
            CONFIG,
            Some(valid_instance.replace("pattern_ratchet.old", "pattern_ratchet.Old")),
            "instance name \"Old\" must be",
        ),
        ("missing", CONFIG, None, "could not read"),
        (
            "unknown baseline section",
            BASELINE,
            text("[file_size]\n[file_sizes]\n"),
            parse,
        ),
        (
            "non-integer cap",
            BASELINE,
            text("[file_size]\n\"crates/a/src/lib.rs\" = \"9\"\n"),
            parse,
        ),
        ("missing baseline", BASELINE, None, "could not read"),
        (
            "baseline table for no instance",
            BASELINE,
            text("[file_size]\n[pattern_ratchet.gone]\n"),
            "[pattern_ratchet.gone] names no instance in ARCHITECTURE.toml",
        ),
        (
            "non-integer pattern_ratchet cap",
            BASELINE,
            text("[file_size]\n[pattern_ratchet.old]\n\"crates/a/src/lib.rs\" = \"1\"\n"),
            parse,
        ),
        (
            "glob member",
            MANIFEST,
            members("crates/*/src"),
            "member crates/*/src contains glob characters",
        ),
        (
            "glob in a directory",
            MANIFEST,
            members("crates/a*/*"),
            glob,
        ),
        (
            "glob over ..",
            MANIFEST,
            members("crates/../*"),
            unnormalized,
        ),
        ("glob ?", MANIFEST, members("crates/b?"), glob),
        ("glob [", MANIFEST, members("crates/[b"), glob),
        ("glob ]", MANIFEST, members("crates/b]"), glob),
        ("glob {", MANIFEST, members("crates/{b"), glob),
        ("glob }", MANIFEST, members("crates/b}"), glob),
        (
            "member with ..",
            MANIFEST,
            members("crates/b/../b"),
            unnormalized,
        ),
        (
            "member with .",
            MANIFEST,
            members("crates/./b"),
            unnormalized,
        ),
        (
            "member with //",
            MANIFEST,
            members("crates//b"),
            unnormalized,
        ),
        (
            "member ending in /",
            MANIFEST,
            members("crates/b/"),
            unnormalized,
        ),
        (
            "absolute member",
            MANIFEST,
            members("/crates/b"),
            unnormalized,
        ),
        ("empty member", MANIFEST, members(""), unnormalized),
        (
            "missing member",
            MANIFEST,
            members("crates/c"),
            "member crates/c has no Cargo.toml",
        ),
        (
            "no members",
            MANIFEST,
            text("[workspace]\n"),
            "has no [workspace] members list",
        ),
    ];
    for (name, file, contents, problem) in cases {
        let ws = workspace(&[]);
        let path = ws.path().join(file);
        match contents {
            Some(contents) => fs::write(&path, contents).unwrap(),
            None => fs::remove_file(&path).unwrap(),
        }

        let error = Context::load(ws.path()).expect_err(name).to_string();

        assert!(error.contains(file), "{name}: {error}");
        assert!(error.contains(problem), "{name}: {error}");
    }

    let cases = [
        (
            "ARCHITECTURE.toml",
            "[rules.file_size\n",
            "could not parse ",
        ),
        (
            "ARCHITECTURE.toml",
            &instance(&["(old_table"], &[]),
            "regex parse error",
        ),
        (
            "ARCHITECTURE.toml",
            &instance(&["old_table"], &["crates/{a"]),
            "error parsing glob",
        ),
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/a/../a\"]\n",
            "Cargo.toml: workspace member \"crates/a/../a\" has",
        ),
    ];
    for (file, contents, problem) in cases {
        let ws = workspace(&[(file, contents.to_owned())]);
        for format in ["human", "rdjson"] {
            let run = run(ws.path(), &["--format", format]);
            assert_eq!(run.code, 2, "{file} {format}");
            assert_eq!(run.stdout, "", "{file} {format}");
            assert!(
                run.stderr.starts_with("archcheck: error: ") && run.stderr.contains(problem),
                "{}",
                run.stderr
            );
        }
    }
}

/// `crates/*` names every directory in `crates`, as Cargo expands it: files
/// beside them are skipped, a directory listed twice is read once, and a
/// directory without a manifest is a missing member.
#[test]
fn every_directory_member_expands() {
    let ws = workspace(&[
        (
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/*\", \"crates/a\"]\n".to_owned(),
        ),
        ("crates/a/src/lib.rs", code(1)),
        ("crates/b/src/lib.rs", code(2)),
        ("crates/b/src/tests.rs", code(9)),
        ("crates/README.md", "not a member\n".to_owned()),
    ]);

    let ctx = Context::load(ws.path()).unwrap();

    let files: Vec<_> = ctx
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.code_lines))
        .collect();
    assert_eq!(
        files,
        [("crates/a/src/lib.rs", 1), ("crates/b/src/lib.rs", 2)]
    );

    fs::create_dir_all(ws.path().join("crates/c/src")).unwrap();
    let error = Context::load(ws.path()).unwrap_err().to_string();
    assert!(
        error.contains("member crates/c has no Cargo.toml"),
        "{error}"
    );
}

/// Linux only: macOS file systems refuse names that are not UTF-8.
#[cfg(target_os = "linux")]
#[test]
fn a_rust_file_name_that_is_not_utf8_exits_2() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};

    let ws = workspace(&[]);
    let src = ws.path().join("crates/a/src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join(OsStr::from_bytes(b"\xff.rs")), "").unwrap();

    let run = run(ws.path(), &[]);

    assert_eq!(run.code, 2, "{}", run.stdout);
    assert!(
        run.stderr.contains("\\xFF.rs\" is not valid UTF-8"),
        "{}",
        run.stderr
    );
}

/// `--write-baseline` lowers the entries still over the limit to their
/// current size and removes the rest; a file without an entry, or one that
/// grew past its cap, is listed, not added or raised.
#[test]
fn write_baseline_output() {
    type Sizes<'a> = &'a [(&'a str, usize)];
    let not_added = |path: &str, lines: usize| {
        format!(
            "not added: {path} ({lines} code lines); split it, or add an entry by hand if this \
             is a deliberate exception"
        )
    };
    let not_raised = |path: &str, lines: usize, cap: usize| {
        format!(
            "not raised: {path} ({lines} code lines, cap {cap}); split it, or raise the cap by \
             hand if this is a deliberate exception"
        )
    };
    // Each case: entries, files, the baseline written, the lines listed, and
    // the behaviours still reporting afterwards.
    type Case<'a> = (Sizes<'a>, Sizes<'a>, &'a str, Vec<String>, Vec<&'a str>);
    let cases: &[Case] = &[
        (
            &[
                ("crates/a/src/grew.rs", LIMIT + 1),
                ("crates/a/src/shrank.rs", LIMIT + 4),
                ("crates/a/src/same.rs", LIMIT + 2),
                ("crates/a/src/fell.rs", LIMIT + 3),
                ("crates/a/src/gone.rs", LIMIT + 3),
                ("./crates/a/src/same.rs", LIMIT + 2),
            ],
            &[
                ("crates/a/src/grew.rs", LIMIT + 3),
                ("crates/a/src/shrank.rs", LIMIT + 1),
                ("crates/a/src/same.rs", LIMIT + 2),
                ("crates/a/src/fell.rs", LIMIT),
                ("crates/b/src/new.rs", LIMIT + 7),
                ("crates/a/src/ok.rs", LIMIT),
                ("crates/a/src/tests.rs", LIMIT + 9),
            ],
            "[file_size]\n\"crates/a/src/grew.rs\" = 6\n\"crates/a/src/same.rs\" = 7\n\
             \"crates/a/src/shrank.rs\" = 6\n",
            vec![
                not_raised("crates/a/src/grew.rs", 8, 6),
                not_added("crates/b/src/new.rs", 12),
            ],
            vec!["no_crossing", "listed_no_growth"],
        ),
        (
            &[],
            &[("crates/a/src/ok.rs", LIMIT)],
            "[file_size]\n",
            vec![],
            vec![],
        ),
    ];
    for (entries, sizes, expected, expected_not_added, expected_left) in cases {
        let mut files: Vec<(&str, String)> = sizes
            .iter()
            .map(|(path, lines)| (*path, code(*lines)))
            .collect();
        files.push(("architecture-baseline.toml", baseline(entries)));
        let ws = workspace(&files);

        let written = write_baseline(ws.path()).unwrap();

        assert_eq!(written.not_added, *expected_not_added);
        let written = fs::read_to_string(ws.path().join("architecture-baseline.toml")).unwrap();
        assert!(written.starts_with("# Existing violations"), "{written}");
        let body: String = written
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
            .map(|line| format!("{line}\n"))
            .collect();
        assert_eq!(body, *expected);
        let left: Vec<_> = findings(ws.path())
            .into_iter()
            .map(|(behaviour, _)| behaviour)
            .collect();
        assert_eq!(left, *expected_left);
    }

    // The old baseline is read, so one that does not parse is left alone.
    let ws = workspace(&[("architecture-baseline.toml", "not toml".to_owned())]);
    let error = write_baseline(ws.path()).unwrap_err().to_string();
    assert!(error.contains("could not parse"), "{error}");
    let left = fs::read_to_string(ws.path().join("architecture-baseline.toml")).unwrap();
    assert_eq!(left, "not toml");

    let ws = workspace(&[
        (
            "architecture-baseline.toml",
            baseline(&[("crates/a/src/listed.rs", LIMIT + 1)]),
        ),
        ("crates/a/src/listed.rs", code(LIMIT + 2)),
        ("crates/a/src/big.rs", code(LIMIT + 1)),
    ]);
    let run = run(ws.path(), &["--write-baseline"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let mut lines = run.stdout.lines();
    let listed: Vec<&str> = lines.by_ref().take(2).collect();
    assert_eq!(
        listed,
        [
            not_added("crates/a/src/big.rs", 6),
            not_raised("crates/a/src/listed.rs", 7, 6),
        ]
    );
    let wrote = lines.next().unwrap();
    assert!(
        wrote.starts_with("archcheck: wrote 1 file_size entries to "),
        "{}",
        run.stdout
    );
    let written = fs::read_to_string(ws.path().join("architecture-baseline.toml")).unwrap();
    assert!(
        written.contains("\"crates/a/src/listed.rs\" = 6"),
        "the cap is not raised: {written}"
    );
}

/// A `--base-baseline` that cannot be read is an error; one that does not
/// parse is a warning after the summary, with the comparison skipped.
#[test]
fn base_baseline_problems() {
    let cases: &[(&str, &str, Option<&str>, i32, &str)] = &[
        ("missing", "base.toml", None, 2, "could not read"),
        ("a directory", "crates", None, 2, "could not read"),
        (
            "unparseable",
            "base.toml",
            Some("[file_size\n"),
            0,
            "could not parse",
        ),
        (
            "non-integer cap",
            "base.toml",
            Some("[file_size]\n\"crates/a/src/lib.rs\" = \"9\"\n"),
            0,
            "could not parse",
        ),
    ];
    for (name, file, contents, code, problem) in cases {
        let ws = workspace(&[]);
        let path = ws.path().join(file);
        if let Some(contents) = contents {
            fs::write(&path, contents).unwrap();
        }
        let path = path.to_str().unwrap();
        for format in ["human", "rdjson"] {
            let run = run(ws.path(), &["--format", format, "--base-baseline", path]);

            assert_eq!(run.code, *code, "{name} {format}: {}", run.stderr);
            if *code == 2 {
                assert_eq!(run.stdout, "", "{name} {format}");
                assert!(
                    run.stderr.starts_with("archcheck: error: ")
                        && run.stderr.contains(path)
                        && run.stderr.contains(problem),
                    "{name}: {}",
                    run.stderr
                );
                continue;
            }
            let summary = if format == "human" {
                run.stdout
            } else {
                serde_json::from_str::<Value>(&run.stdout).expect("one JSON document");
                run.stderr
            };
            let warning = summary.lines().last().unwrap_or_default();
            assert!(
                warning.starts_with(&format!("archcheck: warning: {problem} {path} at line "))
                    && warning.ends_with("file_size.no_raised_caps skipped"),
                "{name} {format}: {summary}"
            );
        }
    }
}

/// A finding is an `ERROR` in required mode and a `WARNING` in advisory
/// mode, on line 1 of its file; a new entry, a raised cap, and a stale entry
/// whose file is gone point at the entry's line in the baseline.
#[test]
fn rdjson_document() {
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            config(["required", "advisory", "advisory", "advisory", "advisory"]),
        ),
        (
            "architecture-baseline.toml",
            "# A comment.\n\n[file_size]\n\"crates/a/src/grew.rs\" = 6\n\n\
             'crates/a/src/gone.rs' = 9\n\"crates/a/src/added.rs\" = 6\n\
             \"crates/a/src/raised.rs\" = 7\n"
                .to_owned(),
        ),
        ("crates/a/src/added.rs", code(6)),
        ("crates/a/src/raised.rs", code(7)),
        ("crates/a/src/grew.rs", code(7)),
        ("crates/b/src/new.rs", code(6)),
    ]);
    let diagnostic = |message: &str, path: &str, line: u64, severity: &str, behaviour: &str| {
        json!({
            "message": message,
            "location": {"path": path, "range": {"start": {"line": line}}},
            "severity": severity,
            "code": {"value": format!("file_size.{behaviour}")},
        })
    };

    let base = baseline(&[
        ("crates/a/src/gone.rs", 9),
        ("crates/a/src/grew.rs", 6),
        ("crates/a/src/raised.rs", 6),
    ]);
    assert_eq!(
        rdjson(ws.path(), Some(&base)),
        json!({
            "source": {"name": "archcheck"},
            "diagnostics": [
                diagnostic(
                    "crates/b/src/new.rs: 6 code lines, over the 5-line limit (blank lines and // \
                     comments are not counted; block comments and inline test modules are). Split it \
                     into submodules by responsibility.",
                    "crates/b/src/new.rs", 1, "ERROR", "no_crossing",
                ),
                diagnostic(
                    "crates/a/src/added.rs is in architecture-baseline.toml but not in the base \
                     branch's copy; files over the 5-line limit can't be added (a renamed file \
                     counts as added). Split the file instead.",
                    "architecture-baseline.toml", 7, "WARNING", "no_new_entries",
                ),
                diagnostic(
                    "crates/a/src/raised.rs: cap raised from 6 to 7 in architecture-baseline.toml; \
                     caps should only go down. Split the file instead.",
                    "architecture-baseline.toml", 8, "WARNING", "no_raised_caps",
                ),
                diagnostic(
                    "crates/a/src/grew.rs grew from 6 to 7 code lines. Once this rule is \
                     required, split the file before adding to it.",
                    "crates/a/src/grew.rs", 1, "WARNING", "listed_no_growth",
                ),
                diagnostic(
                    "crates/a/src/gone.rs: listed in architecture-baseline.toml but no longer a \
                     production Rust file. Remove the entry; a renamed file is checked under its \
                     new path.",
                    "architecture-baseline.toml", 6, "WARNING", "stale_entries",
                ),
            ],
        })
    );
    assert_eq!(
        render(Format::Rdjson, &[], 0),
        "{\"source\":{\"name\":\"archcheck\"},\"diagnostics\":[]}\n"
    );
}

/// reviewdog matches each path against the diff, so paths are exact.
#[cfg(unix)]
#[test]
fn rdjson_paths_are_exact() {
    let names = [
        "crates/a/src/q\"uote.rs",
        "crates/a/src/back\\slash.rs",
        "crates/a/src/tab\t.rs",
        "crates/a/src/new\nline.rs",
    ];
    let ws = workspace(&names.map(|name| (name, code(LIMIT + 1))));

    let document = rdjson(ws.path(), None);

    let mut paths: Vec<&str> = document["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| diagnostic["location"]["path"].as_str().unwrap())
        .collect();
    paths.sort_unstable();
    let mut expected = names.to_vec();
    expected.sort_unstable();
    assert_eq!(paths, expected);
}

#[test]
fn rdjson_on_stdout_and_the_summary_on_stderr() {
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            config(["required", "advisory", "advisory", "advisory", "advisory"]),
        ),
        ("crates/b/src/new.rs", code(6)),
    ]);

    let run = run(ws.path(), &["--format=rdjson"]);

    assert_eq!(run.code, 1, "{}", run.stderr);
    let document: Value = serde_json::from_str(&run.stdout).unwrap();
    assert_eq!(document["diagnostics"][0]["severity"], "ERROR");
    assert_eq!(
        run.stderr,
        "archcheck: 1 finding (0 advisory, 1 required; 1 production Rust files checked)\n"
            .to_owned()
            + SKIPPED
    );
}

#[test]
fn arguments() {
    let ws = workspace(&[]);
    // An empty expectation means nothing on stderr.
    let cases: &[(&[&str], i32, &str)] = &[
        (&["--help"], 0, ""),
        (&["-h"], 0, ""),
        (&["--format", "human"], 0, ""),
        (
            &["--format", "json"],
            2,
            "archcheck: unknown format \"json\"; expected human or rdjson",
        ),
        (&["--format", "github"], 2, "archcheck: unknown format"),
        (&["--format"], 2, "archcheck: --format needs a value"),
        (
            &["--base-baseline"],
            2,
            "archcheck: --base-baseline needs a value",
        ),
        (
            &["--write-baseline", "--base-baseline", "base.toml"],
            2,
            "archcheck: --base-baseline cannot be combined with --write-baseline",
        ),
        (
            &["--base-baseline=base.toml", "--write-baseline"],
            2,
            "archcheck: --base-baseline cannot be combined",
        ),
        (
            &["--bogus"],
            2,
            "archcheck: unexpected argument \"--bogus\"",
        ),
        (
            &["--changed-files", "list"],
            2,
            "archcheck: unexpected argument",
        ),
        (
            &["--summary", "summary.md"],
            2,
            "archcheck: unexpected argument",
        ),
    ];
    for (args, code, stderr) in cases {
        let run = run(ws.path(), args);
        assert_eq!(run.code, *code, "{args:?}: {}", run.stderr);
        if stderr.is_empty() {
            assert_eq!(run.stderr, "", "{args:?}");
        } else {
            assert!(run.stderr.starts_with(stderr), "{args:?}: {}", run.stderr);
        }
        if run.code == 2 {
            assert!(run.stderr.contains("\nusage: archcheck "), "{args:?}");
        }
        if matches!(args[0], "-h" | "--help") {
            assert!(
                run.stdout.starts_with("usage: archcheck [--root <path>]")
                    && run.stdout.ends_with("would add by hand\n"),
                "{args:?}: {}",
                run.stdout
            );
        }
    }

    // Without --root: the workspace containing the current directory.
    let in_dir = |dir: &Path| {
        Command::new(env!("CARGO_BIN_EXE_archcheck"))
            .current_dir(dir)
            .output()
            .expect("run archcheck")
            .status
            .code()
    };
    let nested = ws.path().join("crates/a/nested");
    fs::create_dir_all(&nested).unwrap();
    assert_eq!(in_dir(&nested), Some(0));
    assert_eq!(in_dir(tempfile::tempdir().unwrap().path()), Some(2));
}

/// A write to a full device exits 2 instead of panicking.
#[cfg(target_os = "linux")]
#[test]
fn output_write_errors_exit_2() {
    let full = || {
        fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .expect("open /dev/full")
    };
    let ws = workspace(&[("crates/b/src/new.rs", code(LIMIT + 1))]);
    let cases: &[&[&str]] = &[
        &[],
        &["--format", "rdjson"],
        &["--help"],
        &["--write-baseline"],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_archcheck"))
            .arg("--root")
            .arg(ws.path())
            .args(*args)
            .stdout(full())
            .output()
            .expect("run archcheck");

        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
        assert!(
            stderr.starts_with("archcheck: error: could not write the output: "),
            "{args:?}: {stderr}"
        );
    }

    // The rdjson summary goes to stderr; with nowhere to report, the exit
    // status still says so.
    let status = Command::new(env!("CARGO_BIN_EXE_archcheck"))
        .arg("--root")
        .arg(ws.path())
        .args(["--format", "rdjson"])
        .stdout(std::process::Stdio::null())
        .stderr(full())
        .status()
        .expect("run archcheck");
    assert_eq!(status.code(), Some(2));
}

/// The behaviours of `file_size` and of each `pattern_ratchet` instance, in
/// reporting order.
const BEHAVIOURS: [&str; 5] = [
    "no_crossing",
    "no_new_entries",
    "no_raised_caps",
    "listed_no_growth",
    "stale_entries",
];

const REQUIRED: [&str; 5] = ["required"; 5];

/// A `[rules.pattern_ratchet.<instance>]` table, with the mode of each of
/// [`BEHAVIOURS`] in `modes`.
fn ratchet(instance: &str, patterns: &[&str], allow: &[&str], modes: [&str; 5]) -> String {
    let list = |items: &[&str]| {
        items
            .iter()
            .map(|item| format!("'{item}'"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let table = format!("[rules.pattern_ratchet.{instance}");
    let behaviours: String = BEHAVIOURS
        .iter()
        .zip(modes)
        .map(|(behaviour, mode)| format!("{table}.{behaviour}]\nmode = \"{mode}\"\n"))
        .collect();
    format!(
        "{table}]\npatterns = [{}]\nallow = [{}]\n{behaviours}",
        list(patterns),
        list(allow),
    )
}

/// `ARCHITECTURE.toml` with advisory `file_size` and one instance, `old`,
/// restricting `old_table` and, in any case, `old_log` to
/// `crates/a/src/allowed.rs`, `crates/a/src/allowed/**` and
/// `crates/b/src/*.rs`.
fn old_tables_config(modes: [&str; 5]) -> String {
    format!(
        "{}{}",
        config(ADVISORY),
        ratchet(
            "old",
            &[r"\bold_table\b", r"(?i)\bold_log\b"],
            &[
                "crates/a/src/allowed.rs",
                "crates/a/src/allowed/**",
                "crates/b/src/*.rs"
            ],
            modes,
        ),
    )
}

/// An empty `[file_size]` table and one `[pattern_ratchet.<instance>]` table
/// per entry of `tables`.
fn ratchet_baseline(tables: &[(&str, &[(&str, usize)])]) -> String {
    let mut text = baseline(&[]);
    for (instance, entries) in tables {
        text.push_str(&format!("[pattern_ratchet.{instance}]\n"));
        for (path, cap) in *entries {
            text.push_str(&format!("{path:?} = {cap}\n"));
        }
    }
    text
}

/// `(code, message)` of every `pattern_ratchet` finding, in reporting order.
fn ratchet_findings(root: &Path) -> Vec<(String, String)> {
    let ctx = Context::load(root).expect("the workspace loads");
    check(&ctx)
        .into_iter()
        .filter(|finding| finding.rule == "pattern_ratchet")
        .map(|finding| (finding.code(), finding.message()))
        .collect()
}

/// What a `--write-baseline` run printed.
struct WriteOutput<'a> {
    not_added: Vec<&'a str>,
    summary: &'a str,
    /// The TOML of the entries not added, after its heading line.
    entries: String,
}

fn write_output(stdout: &str) -> WriteOutput<'_> {
    let mut lines = stdout.lines().peekable();
    let mut not_added = Vec::new();
    while let Some(line) = lines.next_if(|line| !line.starts_with("archcheck: ")) {
        not_added.push(line);
    }
    let summary = lines.next().expect("a summary line");
    let entries = match lines.next() {
        None => String::new(),
        Some(heading) => {
            assert_eq!(
                heading,
                "archcheck: the entries not added or not raised, for a deliberate exception made \
                 by hand (no_new_entries or no_raised_caps reports it):"
            );
            lines.map(|line| format!("{line}\n")).collect()
        }
    };
    WriteOutput {
        not_added,
        summary,
        entries,
    }
}

/// The comment `--write-baseline` prints before entries for `table`, which
/// the baseline has.
fn inside(table: &str) -> String {
    format!(
        "# add inside the existing [{table}] table, below its header; not at the end of the \
         file, which may be another table\n"
    )
}

/// `baseline` with `entries`, as `--write-baseline` printed them, pasted
/// where each block's comment says: inside the existing table it names,
/// below its header, or at the end of the file for a new table.
fn paste_entries(baseline: &str, entries: &str) -> String {
    const INSIDE: &str = "# add inside the existing [";
    const NEW: &str = "# add as a new table, header included, at the end of the file\n";
    let mut text = baseline.to_owned();
    let mut lines = entries.split_inclusive('\n').peekable();
    while let Some(comment) = lines.next() {
        let mut block = String::new();
        while let Some(line) = lines.next_if(|line| !line.starts_with('#')) {
            block.push_str(line);
        }
        if comment == NEW {
            text.push_str(&block);
            continue;
        }
        let (table, _) = comment
            .strip_prefix(INSIDE)
            .and_then(|rest| rest.split_once(']'))
            .expect("each block starts with a comment saying where it goes");
        let header = format!("[{table}]\n");
        let at = text
            .find(&header)
            .expect("the baseline has the table the comment names");
        text.insert_str(at + header.len(), &block);
    }
    text
}

/// One row per situation for the `old` instance: baseline entries, files,
/// and the expected `(behaviour, start of message)` of each finding.
#[test]
fn pattern_ratchet_behaviours() {
    const LISTED: &str = "crates/a/src/listed.rs";
    const NEW: &str = "crates/b/src/sub/new.rs";
    type Entries<'a> = &'a [(&'a str, usize)];
    type Files<'a> = &'a [(&'a str, &'a str)];
    type Case<'a> = (&'a str, Entries<'a>, Files<'a>, &'a [(&'a str, &'a str)]);
    let cases: &[Case] = &[
        (
            "a new file with matching lines",
            &[],
            &[(
                NEW,
                "fn f() {}\nlet t = \"old_table\";\n\nlet l = old_log;\n",
            )],
            &[(
                "no_crossing",
                "crates/b/src/sub/new.rs: 2 code lines match the old patterns, first on line 2, \
                 outside the paths [rules.pattern_ratchet.old] in ARCHITECTURE.toml allows. Move \
                 that code behind an allowed path. If the file was renamed, move its entry in \
                 [pattern_ratchet.old] in architecture-baseline.toml to the new path; \
                 no_new_entries reports the moved entry as new, for a reviewer to accept.",
            )],
        ),
        (
            "a line matching several patterns, several times, counts once",
            &[],
            &[(NEW, "old_table old_log old_table\n")],
            &[(
                "no_crossing",
                "crates/b/src/sub/new.rs: 1 code line matches the old",
            )],
        ),
        (
            "only whole identifiers match, case-sensitively by default",
            &[],
            &[(
                NEW,
                "old_table_id\nmy_old_table\nold_tables\nOLD_TABLE\nOLD_LOGS\n",
            )],
            &[],
        ),
        (
            "a (?i) pattern matches in any case",
            &[],
            &[(NEW, "OLD_LOG\nOld_Log\n")],
            &[(
                "no_crossing",
                "crates/b/src/sub/new.rs: 2 code lines match the old patterns, first on line 1,",
            )],
        ),
        (
            "qualified and quoted names are whole identifiers",
            &[],
            &[(NEW, "\"SELECT * FROM public.old_table\"\n")],
            &[(
                "no_crossing",
                "crates/b/src/sub/new.rs: 1 code line matches",
            )],
        ),
        (
            "comment lines do not count",
            &[],
            &[(NEW, "// old_table\n/// old_table\n  //! old_log\n")],
            &[],
        ),
        (
            "a trailing comment is part of its code line",
            &[],
            &[(NEW, "// old_table\nlet x = 1; // old_table\n")],
            &[(
                "no_crossing",
                "crates/b/src/sub/new.rs: 1 code line matches the old patterns, first on line 2,",
            )],
        ),
        (
            "allowed paths may match",
            &[],
            &[
                ("crates/a/src/allowed.rs", "old_table\n"),
                ("crates/a/src/allowed/deep/x.rs", "old_table\n"),
                ("crates/b/src/top.rs", "old_table\n"),
            ],
            &[],
        ),
        (
            "near misses of the allowed paths may not",
            &[],
            &[
                ("crates/a/src/allowed_more.rs", "old_table\n"),
                ("crates/b/src/sub/x.rs", "old_table\n"),
            ],
            &[
                ("no_crossing", "crates/a/src/allowed_more.rs: 1 code line"),
                ("no_crossing", "crates/b/src/sub/x.rs: 1 code line"),
            ],
        ),
        (
            "test files are not production files",
            &[],
            &[
                ("crates/a/src/tests.rs", "old_table\n"),
                ("crates/a/src/x_tests.rs", "old_table\n"),
                ("crates/a/src/m/tests/mod.rs", "old_table\n"),
                ("crates/a/tests/it.rs", "old_table\n"),
            ],
            &[],
        ),
        (
            "a listed file gained a matching line",
            &[(LISTED, 1)],
            &[(LISTED, "old_table\nold_log\n")],
            &[(
                "listed_no_growth",
                "crates/a/src/listed.rs grew from 1 to 2 code lines matching the old patterns. \
                 Once this rule is required, move new matches behind an allowed path.",
            )],
        ),
        (
            "a listed file at its cap",
            &[(LISTED, 2)],
            &[(LISTED, "old_table\nold_log\n")],
            &[],
        ),
        (
            "a listed file lost a matching line",
            &[(LISTED, 2)],
            &[(LISTED, "old_table\n")],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs shrank from 2 to 1 code lines matching the old patterns. \
                 Lower its cap in [pattern_ratchet.old] in architecture-baseline.toml to 1.",
            )],
        ),
        (
            "a listed file has no matching lines left",
            &[(LISTED, 2)],
            &[(LISTED, "// old_table\n")],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs has no code lines left matching the old patterns outside \
                 its allowed paths. Remove it from [pattern_ratchet.old] in \
                 architecture-baseline.toml.",
            )],
        ),
        (
            "a listed file is now allowed",
            &[("crates/a/src/allowed.rs", 1)],
            &[("crates/a/src/allowed.rs", "old_table\n")],
            &[(
                "stale_entries",
                "crates/a/src/allowed.rs has no code lines left",
            )],
        ),
        (
            "a listed file is gone",
            &[(LISTED, 1)],
            &[],
            &[(
                "stale_entries",
                "crates/a/src/listed.rs: listed in [pattern_ratchet.old] in \
                 architecture-baseline.toml but no longer a production Rust file. Remove the \
                 entry; a renamed file is checked under its new path.",
            )],
        ),
        (
            "a listed file became a test file",
            &[(LISTED, 1)],
            &[("crates/a/src/listed_tests.rs", "old_table\n")],
            &[("stale_entries", "crates/a/src/listed.rs: listed in")],
        ),
        (
            "a listed file was renamed",
            &[(LISTED, 1)],
            &[(NEW, "old_table\n")],
            &[
                (
                    "no_crossing",
                    "crates/b/src/sub/new.rs: 1 code line matches",
                ),
                ("stale_entries", "crates/a/src/listed.rs: listed in"),
            ],
        ),
    ];
    for (name, entries, files, expected) in cases {
        let mut files: Vec<(&str, String)> = files
            .iter()
            .map(|(path, text)| (*path, (*text).to_owned()))
            .collect();
        files.push(("ARCHITECTURE.toml", old_tables_config(ADVISORY)));
        files.push((
            "architecture-baseline.toml",
            ratchet_baseline(&[("old", entries)]),
        ));
        let ws = workspace(&files);

        let found = ratchet_findings(ws.path());

        assert_eq!(found.len(), expected.len(), "{name}: {found:#?}");
        for ((code, message), (want_behaviour, want_message)) in found.iter().zip(*expected) {
            assert_eq!(
                code,
                &format!("pattern_ratchet.old.{want_behaviour}"),
                "{name}"
            );
            assert!(message.starts_with(want_message), "{name}: {message}");
        }
    }
}

/// One finding per behaviour, each reported in its own mode; only required
/// findings exit 1. Against the base branch's copy, gone.rs is a new entry
/// and grew.rs's cap was raised from 1 to 2.
#[test]
fn pattern_ratchet_modes_and_exit_codes() {
    let files = |modes: [&str; 5]| {
        vec![
            ("ARCHITECTURE.toml", old_tables_config(modes)),
            (
                "architecture-baseline.toml",
                ratchet_baseline(&[(
                    "old",
                    &[("crates/a/src/gone.rs", 1), ("crates/a/src/grew.rs", 2)],
                )]),
            ),
            (
                "base.toml",
                ratchet_baseline(&[("old", &[("crates/a/src/grew.rs", 1)])]),
            ),
            (
                "crates/a/src/grew.rs",
                "old_table\nold_log\nold_table\n".to_owned(),
            ),
            ("crates/b/src/sub/new.rs", "old_table\n".to_owned()),
        ]
    };
    let mut cases = vec![(ADVISORY, 0)];
    for required in 0..BEHAVIOURS.len() {
        let mut modes = ADVISORY;
        modes[required] = "required";
        cases.push((modes, 1));
    }
    for (modes, expected) in cases {
        let ws = workspace(&files(modes));
        let base = ws.path().join("base.toml");

        let run = run(ws.path(), &["--base-baseline", base.to_str().unwrap()]);

        assert_eq!(
            run.code, expected,
            "{modes:?}: {}{}",
            run.stdout, run.stderr
        );
        let headings: Vec<&str> = run
            .stdout
            .lines()
            .filter(|line| line.starts_with("pattern_ratchet."))
            .collect();
        let expected: Vec<String> = BEHAVIOURS
            .iter()
            .zip(modes)
            .map(|(behaviour, mode)| format!("pattern_ratchet.old.{behaviour} ({mode}):"))
            .collect();
        assert_eq!(headings, expected);
    }

    let mut modes = ADVISORY;
    modes[3] = "required";
    let ws = workspace(&files(modes));
    let growth = "crates/a/src/grew.rs grew from 2 to 3 code lines matching the old patterns. \
                  Move new matches behind an allowed path.";
    assert!(
        ratchet_findings(ws.path())
            .iter()
            .any(|(_, message)| message == growth)
    );
}

/// `no_new_entries` and `no_raised_caps` compare each instance's table with
/// the base branch's copy of it, read leniently and on its own: a table for
/// another instance is ignored, and one that does not parse skips only that
/// instance's comparisons, with a warning. The baseline lists
/// `crates/a/src/listed.rs` (cap 2) and `crates/a/src/kept.rs` (cap 1), at
/// their counts.
#[test]
fn pattern_ratchet_base_baseline() {
    const LISTED: &str = "crates/a/src/listed.rs";
    let new = "pattern_ratchet.old.no_new_entries";
    let raised = "pattern_ratchet.old.no_raised_caps";
    // The line's skipped comparisons, for `codes` separated by ", ".
    let both = |codes: &str| {
        let comparisons: Vec<String> = codes
            .split(", ")
            .map(|code| format!("{code}.no_new_entries and {code}.no_raised_caps"))
            .collect();
        format!("{} skipped", comparisons.join(", "))
    };
    // Name, base copy, finding codes, (code, position) of each skip, and
    // the base's tables for instances that are not configured.
    type Case<'a> = (
        &'a str,
        Option<&'a str>,
        &'a [&'a str],
        &'a [(&'a str, &'a str)],
        &'a [&'a str],
    );
    let cases: &[Case] = &[
        (
            "the same entries and caps",
            Some(
                "[pattern_ratchet.old]\n\"crates/a/src/listed.rs\" = 2\n\"crates/a/src/kept.rs\" = 1\n",
            ),
            &[],
            &[],
            &[],
        ),
        (
            "a new entry",
            Some("[pattern_ratchet.old]\n\"crates/a/src/kept.rs\" = 1\n"),
            &[new],
            &[],
            &[],
        ),
        (
            "a raised cap",
            Some(
                "[pattern_ratchet.old]\n\"crates/a/src/listed.rs\" = 1\n\"crates/a/src/kept.rs\" = 1\n",
            ),
            &[raised],
            &[],
            &[],
        ),
        (
            "a lowered cap and a removed entry",
            Some(
                "[pattern_ratchet.old]\n\"crates/a/src/listed.rs\" = 3\n\"crates/a/src/kept.rs\" = 1\n\
                 \"crates/a/src/gone.rs\" = 4\n",
            ),
            &[],
            &[],
            &[],
        ),
        (
            "no table for the instance",
            Some("[file_size]\n"),
            &[new, new],
            &[],
            &[],
        ),
        (
            "the instance renamed: the old name's table is ignored",
            Some(
                "[pattern_ratchet.older]\n\"crates/a/src/listed.rs\" = 2\n\"crates/a/src/kept.rs\" = 1\n",
            ),
            &[new, new],
            &[],
            &["older"],
        ),
        (
            "a table that does not parse, for an instance not configured",
            Some(
                "[pattern_ratchet.gone]\n\"x\" = \"1\"\n[pattern_ratchet.old]\n\
                 \"crates/a/src/listed.rs\" = 2\n\"crates/a/src/kept.rs\" = 1\n",
            ),
            &[],
            &[],
            &["gone"],
        ),
        (
            "the instance's table does not parse",
            Some(
                "[pattern_ratchet.old]\n\"crates/a/src/kept.rs\" = 1\n\"crates/a/src/listed.rs\" = \"2\"\n",
            ),
            &[],
            &[("pattern_ratchet.old", "at line 3")],
            &[],
        ),
        (
            "[file_size] does not parse: only file_size is skipped",
            Some("[file_size]\n\"x\" = -1\n[pattern_ratchet.old]\n\"crates/a/src/kept.rs\" = 1\n"),
            &[new],
            &[("file_size", "at line 2")],
            &[],
        ),
        (
            "pattern_ratchet is not a table",
            Some("pattern_ratchet = 3\n"),
            &[],
            &[("pattern_ratchet.old", "at line 1")],
            &[],
        ),
        (
            "the instance is not a table",
            Some("[pattern_ratchet]\nold = 3\n"),
            &[],
            &[("pattern_ratchet.old", "at line 2")],
            &[],
        ),
        (
            "not TOML",
            Some("[pattern_ratchet\n"),
            &[],
            // One line for both tables, not one each.
            &[("file_size, pattern_ratchet.old", "at line 1")],
            &[],
        ),
        (
            "no --base-baseline",
            None,
            &[],
            &[("file_size", ""), ("pattern_ratchet.old", "")],
            &[],
        ),
    ];
    for (name, base, expected, problems, ignored) in cases {
        let ws = workspace(&[
            ("ARCHITECTURE.toml", old_tables_config(ADVISORY)),
            (
                "architecture-baseline.toml",
                ratchet_baseline(&[("old", &[(LISTED, 2), ("crates/a/src/kept.rs", 1)])]),
            ),
            (LISTED, "old_table\nold_log\n".to_owned()),
            ("crates/a/src/kept.rs", "old_table\n".to_owned()),
        ]);

        let ctx = load(ws.path(), *base);

        let found: Vec<String> = check(&ctx).iter().map(|finding| finding.code()).collect();
        assert_eq!(found, *expected, "{name}");
        let path = ws.path().join("base-baseline.toml");
        let (info, skipped): (Vec<String>, Vec<String>) = skipped(&ctx)
            .into_iter()
            .partition(|line| line.starts_with("base baseline has "));
        let expected_info: Vec<String> = ignored
            .iter()
            .map(|instance| {
                format!(
                    "base baseline has [pattern_ratchet.{instance}], which is not configured; \
                     skipped"
                )
            })
            .collect();
        assert_eq!(info, expected_info, "{name}");
        assert_eq!(skipped.len(), problems.len(), "{name}: {skipped:?}");
        for (line, (code, at)) in skipped.iter().zip(*problems) {
            match base {
                None => assert_eq!(
                    *line,
                    format!(
                        "{} (--no-base given, or no [base] branch in ARCHITECTURE.toml and no \
                         --base-baseline)",
                        both(code)
                    ),
                    "{name}"
                ),
                Some(_) => assert!(
                    line.starts_with(&format!(
                        "warning: could not parse {} {at}: ",
                        path.display()
                    )) && line.ends_with(&format!("; {}", both(code)))
                        && !line.contains('\n'),
                    "{name}: {line}"
                ),
            }
        }
    }

    // The messages, for a new entry and a raised cap.
    let ws = workspace(&[
        ("ARCHITECTURE.toml", old_tables_config(ADVISORY)),
        (
            "architecture-baseline.toml",
            ratchet_baseline(&[("old", &[(LISTED, 2), ("crates/a/src/kept.rs", 1)])]),
        ),
        (LISTED, "old_table\nold_log\n".to_owned()),
        ("crates/a/src/kept.rs", "old_table\n".to_owned()),
    ]);
    let found = findings_against(
        ws.path(),
        Some("[pattern_ratchet.old]\n\"crates/a/src/listed.rs\" = 1\n"),
    );
    assert_eq!(
        found,
        [
            (
                "no_new_entries",
                "crates/a/src/kept.rs is in [pattern_ratchet.old] in architecture-baseline.toml \
                 but not in the base branch's copy; files outside the paths \
                 [rules.pattern_ratchet.old] in ARCHITECTURE.toml allows can't be added (a \
                 renamed file counts as added). Move that code behind an allowed path instead."
                    .to_owned()
            ),
            (
                "no_raised_caps",
                "crates/a/src/listed.rs: cap raised from 1 to 2 in [pattern_ratchet.old] in \
                 architecture-baseline.toml; caps should only go down. Move that code behind an \
                 allowed path instead."
                    .to_owned()
            ),
        ]
    );
}

/// `ARCHITECTURE.toml` with advisory `file_size` and instances restricting
/// `<instance>_table`, with no allowed paths.
fn instances_config(instances: &[&str]) -> String {
    let mut text = config(ADVISORY);
    for instance in instances {
        text.push_str(&ratchet(
            instance,
            &[&format!(r"\b{instance}_table\b")],
            &[],
            ADVISORY,
        ));
    }
    text
}

/// A base table that does not parse skips its own instance's comparisons
/// only: another configured instance is still compared, and reports both a
/// new entry and a raised cap.
#[test]
fn pattern_ratchet_base_table_that_does_not_parse_skips_only_its_instance() {
    let ws = workspace(&[
        ("ARCHITECTURE.toml", instances_config(&["alpha", "beta"])),
        (
            "architecture-baseline.toml",
            ratchet_baseline(&[
                ("alpha", &[("crates/a/src/a.rs", 1)]),
                (
                    "beta",
                    &[("crates/a/src/b.rs", 2), ("crates/a/src/c.rs", 1)],
                ),
            ]),
        ),
        ("crates/a/src/a.rs", "alpha_table\n".to_owned()),
        ("crates/a/src/b.rs", "beta_table\nbeta_table\n".to_owned()),
        ("crates/a/src/c.rs", "beta_table\n".to_owned()),
    ]);
    let base = "[pattern_ratchet.alpha]\n\"crates/a/src/a.rs\" = \"1\"\n\
                [pattern_ratchet.beta]\n\"crates/a/src/b.rs\" = 1\n";

    let ctx = load(ws.path(), Some(base));

    let found: Vec<(String, String)> = check(&ctx)
        .iter()
        .map(|finding| (finding.code(), finding.path.clone()))
        .collect();
    assert_eq!(
        found,
        [
            (
                "pattern_ratchet.beta.no_new_entries".to_owned(),
                "crates/a/src/c.rs".to_owned()
            ),
            (
                "pattern_ratchet.beta.no_raised_caps".to_owned(),
                "crates/a/src/b.rs".to_owned()
            ),
        ]
    );
    let path = ws.path().join("base-baseline.toml");
    assert_eq!(
        skipped(&ctx),
        [format!(
            "warning: could not parse {} at line 2: invalid type: string \"1\", expected usize; \
             pattern_ratchet.alpha.no_new_entries and pattern_ratchet.alpha.no_raised_caps \
             skipped",
            path.display()
        )]
    );
}

/// The skip lines, in order: `file_size`'s, then each configured instance's,
/// in configuration order, then one per table of an instance that is not
/// configured, in name order, whatever the order of the base copy.
#[test]
fn skip_lines_come_in_rule_then_instance_order() {
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            instances_config(&["alpha", "beta", "gamma"]),
        ),
        (
            "architecture-baseline.toml",
            ratchet_baseline(&[("alpha", &[]), ("beta", &[]), ("gamma", &[])]),
        ),
    ]);
    let base = "[pattern_ratchet.zeta]\n\
                [pattern_ratchet.gamma]\n\"a\" = -2\n\
                [pattern_ratchet.beta]\n\
                [pattern_ratchet.delta]\nx = \"y\"\n\
                [pattern_ratchet.alpha]\n\"a\" = \"1\"\n\
                [file_size]\n\"x\" = -1\n";

    let ctx = load(ws.path(), Some(base));

    let path = ws.path().join("base-baseline.toml");
    let warning = |line: usize, error: &str, code: &str| {
        format!(
            "warning: could not parse {} at line {line}: {error}; {code}.no_new_entries and \
             {code}.no_raised_caps skipped",
            path.display()
        )
    };
    assert_eq!(
        skipped(&ctx),
        [
            warning(
                10,
                "invalid value: integer `-1`, expected usize",
                "file_size"
            ),
            warning(
                8,
                "invalid type: string \"1\", expected usize",
                "pattern_ratchet.alpha"
            ),
            warning(
                3,
                "invalid value: integer `-2`, expected usize",
                "pattern_ratchet.gamma"
            ),
            "base baseline has [pattern_ratchet.delta], which is not configured; skipped"
                .to_owned(),
            "base baseline has [pattern_ratchet.zeta], which is not configured; skipped".to_owned(),
        ]
    );
}

/// Each instance reads only its own patterns, allowed paths, modes and
/// baseline table, and reports under its own code.
#[test]
fn pattern_ratchet_instances_are_independent() {
    let files = |w: &str| {
        vec![
            (
                "ARCHITECTURE.toml",
                format!(
                    "{}{}{}",
                    config(ADVISORY),
                    ratchet("alpha", &[r"\balpha_table\b"], &["crates/a/**"], ADVISORY,),
                    ratchet(
                        "beta",
                        &[r"\bbeta_table\b"],
                        &["crates/a/src/beta_home.rs"],
                        ["advisory", "advisory", "advisory", "required", "advisory"],
                    ),
                ),
            ),
            (
                "architecture-baseline.toml",
                ratchet_baseline(&[
                    ("alpha", &[("crates/b/src/y.rs", 3)]),
                    ("beta", &[("crates/b/src/w.rs", 1)]),
                ]),
            ),
            // alpha allows it; beta does not.
            (
                "crates/a/src/x.rs",
                "alpha_table\nbeta_table\nbeta_table\n".to_owned(),
            ),
            // At alpha's cap; alpha's entry does not cover beta.
            (
                "crates/b/src/y.rs",
                "alpha_table\nalpha_table\nalpha_table\nbeta_table\n".to_owned(),
            ),
            ("crates/b/src/z.rs", "alpha_table\n".to_owned()),
            ("crates/b/src/w.rs", w.to_owned()),
        ]
    };
    let ws = workspace(&files("beta_table\nbeta_table\n"));

    let run_grown = run(ws.path(), &[]);

    assert_eq!(
        run_grown.code, 1,
        "{}{}",
        run_grown.stdout, run_grown.stderr
    );
    let headings: Vec<&str> = run_grown
        .stdout
        .lines()
        .filter(|line| line.starts_with("pattern_ratchet."))
        .collect();
    assert_eq!(
        headings,
        [
            "pattern_ratchet.alpha.no_crossing (advisory):",
            "pattern_ratchet.beta.no_crossing (advisory):",
            "pattern_ratchet.beta.listed_no_growth (required):",
        ]
    );
    let found: Vec<(String, String)> = ratchet_findings(ws.path())
        .into_iter()
        .map(|(code, message)| (code, message.split(" outside").next().unwrap().to_owned()))
        .collect();
    let finding = |code: &str, message: &str| (code.to_owned(), message.to_owned());
    assert_eq!(
        found,
        [
            finding(
                "pattern_ratchet.alpha.no_crossing",
                "crates/b/src/z.rs: 1 code line matches the alpha patterns, first on line 1,",
            ),
            finding(
                "pattern_ratchet.beta.no_crossing",
                "crates/a/src/x.rs: 2 code lines match the beta patterns, first on line 2,",
            ),
            finding(
                "pattern_ratchet.beta.no_crossing",
                "crates/b/src/y.rs: 1 code line matches the beta patterns, first on line 4,",
            ),
            finding(
                "pattern_ratchet.beta.listed_no_growth",
                "crates/b/src/w.rs grew from 1 to 2 code lines matching the beta patterns. Move \
                 new matches behind an allowed path.",
            ),
        ]
    );

    // Without beta's required finding, alpha's advisory one does not fail.
    let ws = workspace(&files("beta_table\n"));
    let run_at_cap = run(ws.path(), &[]);
    assert_eq!(
        run_at_cap.code, 0,
        "{}{}",
        run_at_cap.stdout, run_at_cap.stderr
    );
    assert!(
        run_at_cap
            .stdout
            .contains("pattern_ratchet.alpha.no_crossing (advisory):"),
        "{}",
        run_at_cap.stdout
    );
}

/// `--write-baseline` updates every existing table of both rules, empty or
/// not: an entry still matching is lowered to its current count, an entry
/// at zero, now allowed or whose file is gone is removed, and a matching
/// file without an entry is listed, not added.
#[test]
fn pattern_ratchet_write_baseline() {
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            format!(
                "{}{}",
                old_tables_config(REQUIRED),
                ratchet("unused", &[r"\bnowhere\b"], &[], REQUIRED,),
            ),
        ),
        (
            "architecture-baseline.toml",
            "[file_size]\n\"crates/b/src/sub/big.rs\" = 8\n\
             [pattern_ratchet.old]\n\"crates/a/src/z.rs\" = 3\n\"crates/a/src/one.rs\" = 3\n\
             \"crates/a/src/none.rs\" = 1\n\"crates/a/src/allowed.rs\" = 1\n\
             \"crates/a/src/gone.rs\" = 1\n\"crates/b/src/sub/big.rs\" = 2\n\
             [pattern_ratchet.unused]\n"
                .to_owned(),
        ),
        (
            "crates/a/src/z.rs",
            "old_table\n// old_log\nold_log\n".to_owned(),
        ),
        ("crates/a/src/one.rs", "old_log\n".to_owned()),
        ("crates/a/src/none.rs", "old_tables\n".to_owned()),
        ("crates/a/src/allowed.rs", "old_table\n".to_owned()),
        ("crates/a/src/tests.rs", "old_table\n".to_owned()),
        // Over the file_size limit, with matching lines.
        (
            "crates/b/src/sub/big.rs",
            format!("old_table\nold_log\n{}", code(LIMIT)),
        ),
        ("crates/a/src/new.rs", "old_table\nOLD_LOG\n".to_owned()),
    ]);

    let wrote = run(ws.path(), &["--write-baseline"]);

    assert_eq!(wrote.code, 0, "{}", wrote.stderr);
    let output = write_output(&wrote.stdout);
    assert_eq!(
        output.not_added,
        [
            "not added: crates/a/src/new.rs (2 code lines matching the old patterns); move them \
          behind an allowed path, or add an entry by hand if this is a deliberate exception"
        ]
    );
    assert!(
        output.summary.starts_with(
            "archcheck: wrote 1 file_size, 3 pattern_ratchet.old, 0 pattern_ratchet.unused \
             entries to "
        ),
        "{}",
        wrote.stdout
    );
    assert_eq!(
        output.entries,
        format!(
            "{}\"crates/a/src/new.rs\" = 2\n",
            inside("pattern_ratchet.old")
        )
    );
    let written = fs::read_to_string(ws.path().join("architecture-baseline.toml")).unwrap();
    let body: String = written
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .map(|line| format!("{line}\n"))
        .collect();
    assert_eq!(
        body,
        "[file_size]\n\"crates/b/src/sub/big.rs\" = 7\n[pattern_ratchet.old]\n\
         \"crates/a/src/one.rs\" = 1\n\"crates/a/src/z.rs\" = 2\n\
         \"crates/b/src/sub/big.rs\" = 2\n[pattern_ratchet.unused]\n"
    );
    // Only the file left out is still a finding.
    let checked = run(ws.path(), &[]);
    assert_eq!(checked.code, 1, "{}{}", checked.stdout, checked.stderr);
    assert_eq!(codes(ws.path()), ["pattern_ratchet.old.no_crossing"]);
}

/// Neither form of `--write-baseline` creates the table of an instance the
/// baseline has none for: its matching files are listed, with the table to
/// add by hand, and the scoped form leaves the file alone.
#[test]
fn pattern_ratchet_write_creates_no_table() {
    const BASELINE: &str = "architecture-baseline.toml";
    let generated = "[file_size]\n[pattern_ratchet.old]\n\"crates/a/src/o.rs\" = 1\n";
    let hint = "architecture-baseline.toml has no [pattern_ratchet.fresh] table; for a new \
                instance, add the table and its entries by hand";
    let not_added = [
        format!("not added: crates/a/src/f.rs (1 code line matching the fresh patterns); {hint}"),
        format!("not added: crates/b/src/g.rs (2 code lines matching the fresh patterns); {hint}"),
    ];
    let entries = "# add as a new table, header included, at the end of the file\n\
                   [pattern_ratchet.fresh]\n\"crates/a/src/f.rs\" = 1\n\"crates/b/src/g.rs\" = 2\n";
    for scoped in [false, true] {
        let ws = workspace(&[
            (
                "ARCHITECTURE.toml",
                format!(
                    "{}{}",
                    old_tables_config(ADVISORY),
                    ratchet("fresh", &[r"\bfresh_table\b"], &[], ADVISORY),
                ),
            ),
            (BASELINE, generated.to_owned()),
            ("crates/a/src/o.rs", "old_table\n".to_owned()),
            ("crates/a/src/f.rs", "fresh_table\n".to_owned()),
            ("crates/b/src/g.rs", "fresh_table\nfresh_table\n".to_owned()),
        ]);
        let args: &[&str] = if scoped {
            &["--write-baseline=pattern_ratchet.fresh"]
        } else {
            &["--write-baseline"]
        };

        let wrote = run(ws.path(), args);

        assert_eq!(wrote.code, 0, "{args:?}: {}", wrote.stderr);
        let output = write_output(&wrote.stdout);
        assert_eq!(output.not_added, not_added, "{args:?}");
        let summary = if scoped {
            format!(
                "archcheck: {} has no [pattern_ratchet.fresh] table, which only a hand edit \
                 adds; left it alone",
                ws.path().join(BASELINE).display()
            )
        } else {
            format!(
                "archcheck: wrote 0 file_size, 1 pattern_ratchet.old entries to {}",
                ws.path().join(BASELINE).display()
            )
        };
        assert_eq!(output.summary, summary, "{args:?}");
        assert_eq!(output.entries, entries, "{args:?}");
        let written = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
        assert!(
            !written.contains("[pattern_ratchet.fresh]"),
            "{args:?}: {written}"
        );
        if scoped {
            assert_eq!(written, generated);
        }
        assert_eq!(
            codes(ws.path()),
            [
                "pattern_ratchet.fresh.no_crossing",
                "pattern_ratchet.fresh.no_crossing"
            ],
            "{args:?}"
        );

        // The listed entries, pasted as a new table, are what the instance
        // then tolerates.
        fs::write(ws.path().join(BASELINE), paste_entries(&written, entries)).unwrap();
        assert_eq!(codes(ws.path()), Vec::<String>::new(), "{args:?}");
    }
}

/// `no_crossing`, `listed_no_growth` and a shrank `stale_entries` point at
/// the file's first matching line, and a `stale_entries` for a file without
/// matches at its line 1, so that a pull request changing only the file sees
/// them; `no_new_entries`, `no_raised_caps` and a `stale_entries` for a file
/// that is gone point at the entry's line in the baseline.
#[test]
fn pattern_ratchet_rdjson() {
    let mut modes = ADVISORY;
    modes[0] = "required";
    let ws = workspace(&[
        ("ARCHITECTURE.toml", old_tables_config(modes)),
        (
            "architecture-baseline.toml",
            "[file_size]\n\n[pattern_ratchet.old]\n\"crates/a/src/grew.rs\" = 1\n\
             'crates/a/src/gone.rs' = 3\n\"crates/a/src/shrank.rs\" = 3\n\
             \"crates/a/src/none.rs\" = 1\n"
                .to_owned(),
        ),
        (
            "crates/a/src/grew.rs",
            "fn f() {}\nold_table\nold_log\n".to_owned(),
        ),
        ("crates/a/src/shrank.rs", "\nold_table\n".to_owned()),
        ("crates/a/src/none.rs", "old_tables\n".to_owned()),
        (
            "crates/b/src/sub/new.rs",
            "fn f() {}\n// old_table\nold_log\n".to_owned(),
        ),
    ]);
    let base = "[pattern_ratchet.old]\n\"crates/a/src/grew.rs\" = 1\n\
                \"crates/a/src/gone.rs\" = 3\n\"crates/a/src/shrank.rs\" = 2\n";

    let document = rdjson(ws.path(), Some(base));

    let found: Vec<(&str, &str, u64, &str)> = document["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic["code"]["value"].as_str().unwrap(),
                diagnostic["location"]["path"].as_str().unwrap(),
                diagnostic["location"]["range"]["start"]["line"]
                    .as_u64()
                    .unwrap(),
                diagnostic["severity"].as_str().unwrap(),
            )
        })
        .collect();
    const BASELINE: &str = "architecture-baseline.toml";
    assert_eq!(
        found,
        [
            (
                "pattern_ratchet.old.no_crossing",
                "crates/b/src/sub/new.rs",
                3,
                "ERROR"
            ),
            ("pattern_ratchet.old.no_new_entries", BASELINE, 7, "WARNING"),
            ("pattern_ratchet.old.no_raised_caps", BASELINE, 6, "WARNING"),
            (
                "pattern_ratchet.old.listed_no_growth",
                "crates/a/src/grew.rs",
                2,
                "WARNING"
            ),
            ("pattern_ratchet.old.stale_entries", BASELINE, 5, "WARNING"),
            (
                "pattern_ratchet.old.stale_entries",
                "crates/a/src/none.rs",
                1,
                "WARNING"
            ),
            (
                "pattern_ratchet.old.stale_entries",
                "crates/a/src/shrank.rs",
                2,
                "WARNING"
            ),
        ]
    );
}

/// The `[name]` table of a baseline file, from its header line up to the
/// next table's.
fn table_section(text: &str, name: &str) -> String {
    let header = format!("[{name}]");
    let mut lines = text
        .split_inclusive('\n')
        .skip_while(|line| line.trim_end() != header);
    let first = lines.next().expect("the baseline has the table");
    let rest = lines.take_while(|line| !line.starts_with('['));
    std::iter::once(first).chain(rest).collect()
}

/// The codes of every finding, in reporting order.
fn codes(root: &Path) -> Vec<String> {
    check(&Context::load(root).expect("the workspace loads"))
        .iter()
        .map(|finding| finding.code())
        .collect()
}

/// `--write-baseline=<table>` updates only that table, listing only its
/// files left out; the others stay byte for byte as they were, drifted caps
/// included.
#[test]
fn pattern_ratchet_scoped_write_baseline() {
    const BASELINE: &str = "architecture-baseline.toml";
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            format!(
                "{}{}",
                old_tables_config(ADVISORY),
                ratchet("other", &[r"\bother_table\b"], &[], ADVISORY,),
            ),
        ),
        (
            BASELINE,
            "[file_size]\n\"crates/a/src/big.rs\" = 6\n\
             [pattern_ratchet.old]\n\"crates/a/src/shrinks.rs\" = 2\n\
             [pattern_ratchet.other]\n\"crates/b/src/sub/o.rs\" = 1\n"
                .to_owned(),
        ),
        ("crates/a/src/big.rs", code(LIMIT + 1)),
        ("crates/a/src/shrinks.rs", "old_table\nold_log\n".to_owned()),
        ("crates/b/src/sub/o.rs", "other_table\n".to_owned()),
    ]);
    // In generated form, so that kept tables can be compared byte for byte.
    let generated = run(ws.path(), &["--write-baseline"]);
    assert_eq!(generated.code, 0, "{}", generated.stderr);
    assert!(
        generated.stdout.starts_with(
            "archcheck: wrote 1 file_size, 1 pattern_ratchet.old, 1 pattern_ratchet.other \
             entries to "
        ),
        "{}",
        generated.stdout
    );
    // Every table drifts: big.rs grows past its cap, shrinks.rs loses a
    // matching line, a new file matches `old`, o.rs gains an `other` line,
    // and a new file is over the limit.
    fs::write(ws.path().join("crates/a/src/big.rs"), code(LIMIT + 3)).unwrap();
    fs::write(ws.path().join("crates/a/src/shrinks.rs"), "old_table\n").unwrap();
    fs::write(ws.path().join("crates/b/src/sub/new.rs"), "old_log\n").unwrap();
    fs::write(
        ws.path().join("crates/b/src/sub/o.rs"),
        "other_table\nother_table\n",
    )
    .unwrap();
    fs::write(ws.path().join("crates/a/src/huge.rs"), code(LIMIT + 2)).unwrap();
    let before = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
    assert_eq!(
        table_section(&before, "file_size"),
        "[file_size]\n\"crates/a/src/big.rs\" = 6\n\n"
    );

    let wrote = run(ws.path(), &["--write-baseline=pattern_ratchet.old"]);

    assert_eq!(wrote.code, 0, "{}", wrote.stderr);
    let output = write_output(&wrote.stdout);
    assert_eq!(
        output.not_added,
        [
            "not added: crates/b/src/sub/new.rs (1 code line matching the old patterns); move \
          them behind an allowed path, or add an entry by hand if this is a deliberate exception"
        ]
    );
    assert!(
        output
            .summary
            .starts_with("archcheck: wrote 1 pattern_ratchet.old entries to ")
            && output.summary.ends_with("; other tables kept"),
        "{}",
        wrote.stdout
    );
    assert_eq!(
        output.entries,
        format!(
            "{}\"crates/b/src/sub/new.rs\" = 1\n",
            inside("pattern_ratchet.old")
        )
    );
    let after = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
    assert_eq!(
        table_section(&after, "pattern_ratchet.old"),
        "[pattern_ratchet.old]\n\"crates/a/src/shrinks.rs\" = 1\n\n"
    );
    for kept in ["file_size", "pattern_ratchet.other"] {
        assert_eq!(table_section(&after, kept), table_section(&before, kept));
    }
    assert_eq!(
        codes(ws.path()),
        [
            "file_size.no_crossing",
            "file_size.listed_no_growth",
            "pattern_ratchet.old.no_crossing",
            "pattern_ratchet.other.listed_no_growth"
        ]
    );

    // The other way round, with `old` drifted again: file_size is
    // updated and both instance tables are kept.
    fs::write(
        ws.path().join("crates/a/src/shrinks.rs"),
        "old_table\nold_log\n",
    )
    .unwrap();
    let wrote = run(ws.path(), &["--write-baseline=file_size"]);
    assert_eq!(wrote.code, 0, "{}", wrote.stderr);
    let output = write_output(&wrote.stdout);
    assert_eq!(
        output.not_added,
        [
            "not raised: crates/a/src/big.rs (8 code lines, cap 6); split it, or raise the cap by \
             hand if this is a deliberate exception",
            "not added: crates/a/src/huge.rs (7 code lines); split it, or add an entry by hand if \
             this is a deliberate exception"
        ]
    );
    assert!(
        output
            .summary
            .starts_with("archcheck: wrote 1 file_size entries to "),
        "{}",
        wrote.stdout
    );
    assert_eq!(
        output.entries,
        format!(
            "{}\"crates/a/src/big.rs\" = 8\n\"crates/a/src/huge.rs\" = 7\n",
            inside("file_size")
        )
    );
    let after_file_size = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
    assert_eq!(
        table_section(&after_file_size, "file_size"),
        "[file_size]\n\"crates/a/src/big.rs\" = 6\n\n",
        "a refresh never raises a cap"
    );
    for kept in ["pattern_ratchet.old", "pattern_ratchet.other"] {
        assert_eq!(
            table_section(&after_file_size, kept),
            table_section(&after, kept)
        );
    }
    assert_eq!(
        codes(ws.path()),
        [
            "file_size.no_crossing",
            "file_size.listed_no_growth",
            "pattern_ratchet.old.no_crossing",
            "pattern_ratchet.old.listed_no_growth",
            "pattern_ratchet.other.listed_no_growth"
        ]
    );

    // An unknown table, or a baseline that does not parse, exits 2 and
    // leaves the file alone.
    for table in ["pattern_ratchet.nope", "file_sizes", "pattern_ratchet", ""] {
        let failed = run(ws.path(), &[&format!("--write-baseline={table}")]);
        assert_eq!(failed.code, 2, "{table}: {}", failed.stdout);
        assert!(
            failed.stderr.starts_with(&format!(
                "archcheck: error: no baseline table {table:?}; expected one of: file_size, \
                 pattern_ratchet.old, pattern_ratchet.other"
            )),
            "{table}: {}",
            failed.stderr
        );
        assert_eq!(
            fs::read_to_string(ws.path().join(BASELINE)).unwrap(),
            after_file_size
        );
    }
    fs::write(ws.path().join(BASELINE), "not toml").unwrap();
    let failed = run(ws.path(), &["--write-baseline=file_size"]);
    assert_eq!(failed.code, 2, "{}", failed.stdout);
    assert!(
        failed.stderr.contains("could not parse"),
        "{}",
        failed.stderr
    );
    assert_eq!(
        fs::read_to_string(ws.path().join(BASELINE)).unwrap(),
        "not toml"
    );
}

/// A scoped write of an existing but empty table updates it like any other,
/// so it stays empty and a matching file is listed, not added, with entries
/// to paste inside that table. It is not the last table, so entries pasted
/// at the end of the file would land in another one.
#[test]
fn pattern_ratchet_scoped_write_keeps_an_empty_table() {
    const BASELINE: &str = "architecture-baseline.toml";
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            format!(
                "{}{}",
                old_tables_config(REQUIRED),
                ratchet("other", &[r"\bother_table\b"], &[], REQUIRED),
            ),
        ),
        (
            BASELINE,
            "[file_size]\n[pattern_ratchet.old]\n[pattern_ratchet.other]\n".to_owned(),
        ),
        ("crates/a/src/n.rs", "old_table\n".to_owned()),
    ]);

    let wrote = run(ws.path(), &["--write-baseline=pattern_ratchet.old"]);

    assert_eq!(wrote.code, 0, "{}", wrote.stderr);
    let output = write_output(&wrote.stdout);
    assert_eq!(
        output.not_added,
        [
            "not added: crates/a/src/n.rs (1 code line matching the old patterns); move them \
          behind an allowed path, or add an entry by hand if this is a deliberate exception"
        ]
    );
    assert!(
        output
            .summary
            .starts_with("archcheck: wrote 0 pattern_ratchet.old entries to ")
            && output.summary.ends_with("; other tables kept"),
        "{}",
        wrote.stdout
    );
    assert_eq!(
        output.entries,
        format!(
            "{}\"crates/a/src/n.rs\" = 1\n",
            inside("pattern_ratchet.old")
        )
    );
    let after = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
    assert_eq!(
        table_section(&after, "pattern_ratchet.old"),
        "[pattern_ratchet.old]\n\n"
    );
    assert!(after.ends_with("[pattern_ratchet.other]\n"), "{after}");
    assert_eq!(codes(ws.path()), ["pattern_ratchet.old.no_crossing"]);

    // Pasted inside the existing table, as the comment says, the entries
    // parse and are what that table then tolerates.
    fs::write(
        ws.path().join(BASELINE),
        paste_entries(&after, &output.entries),
    )
    .unwrap();
    assert_eq!(codes(ws.path()), Vec::<String>::new());
}

/// The unscoped write lists the entries of every table, each block saying
/// where it goes; pasted there, each lands in its own table, though the
/// tables they name are first, in the middle and missing, not last.
#[test]
fn write_baseline_entries_paste_into_their_tables() {
    const BASELINE: &str = "architecture-baseline.toml";
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            format!(
                "{}{}{}",
                old_tables_config(REQUIRED),
                ratchet("fresh", &[r"\bfresh_table\b"], &[], REQUIRED),
                ratchet("zz", &[r"\bzz_table\b"], &[], REQUIRED),
            ),
        ),
        (
            BASELINE,
            "[file_size]\n\"crates/a/src/big.rs\" = 6\n[pattern_ratchet.old]\n\
             \"crates/a/src/o.rs\" = 1\n[pattern_ratchet.zz]\n\"crates/a/src/z.rs\" = 1\n"
                .to_owned(),
        ),
        ("crates/a/src/big.rs", code(6)),
        ("crates/a/src/huge.rs", code(7)),
        ("crates/a/src/o.rs", "old_table\n".to_owned()),
        ("crates/a/src/n.rs", "old_table\n".to_owned()),
        ("crates/a/src/z.rs", "zz_table\n".to_owned()),
        ("crates/a/src/f.rs", "fresh_table\n".to_owned()),
    ]);

    let wrote = run(ws.path(), &["--write-baseline"]);

    assert_eq!(wrote.code, 0, "{}", wrote.stderr);
    let output = write_output(&wrote.stdout);
    assert_eq!(output.not_added.len(), 3, "{}", wrote.stdout);
    assert_eq!(
        output.entries,
        format!(
            "{}\"crates/a/src/huge.rs\" = 7\n\
             # add as a new table, header included, at the end of the file\n\
             [pattern_ratchet.fresh]\n\"crates/a/src/f.rs\" = 1\n\
             {}\"crates/a/src/n.rs\" = 1\n",
            inside("file_size"),
            inside("pattern_ratchet.old"),
        )
    );
    let written = fs::read_to_string(ws.path().join(BASELINE)).unwrap();
    assert_eq!(
        codes(ws.path()),
        [
            "file_size.no_crossing",
            "pattern_ratchet.fresh.no_crossing",
            "pattern_ratchet.old.no_crossing"
        ]
    );

    fs::write(
        ws.path().join(BASELINE),
        paste_entries(&written, &output.entries),
    )
    .unwrap();
    assert_eq!(codes(ws.path()), Vec::<String>::new());
    let pasted = Baseline::load(&ws.path().join(BASELINE)).expect("the pasted baseline loads");
    assert_eq!(
        pasted.table_names(),
        [
            "file_size",
            "pattern_ratchet.fresh",
            "pattern_ratchet.old",
            "pattern_ratchet.zz"
        ]
    );
    assert_eq!(
        pasted
            .table("pattern_ratchet.zz")
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["crates/a/src/z.rs"]
    );
}

/// Either form of `--write-baseline` refuses, exits 2 and leaves the file
/// alone when the existing baseline has a table for an instance that is no
/// longer configured, or does not exist.
#[test]
fn pattern_ratchet_write_baseline_errors() {
    const BASELINE: &str = "architecture-baseline.toml";
    let stale = "[file_size]\n[pattern_ratchet.foo]\n\"crates/a/src/x.rs\" = 1\n";
    let ws = workspace(&[
        (
            "ARCHITECTURE.toml",
            format!(
                "{}{}",
                config(ADVISORY),
                ratchet("bar", &[r"\bold_table\b"], &[], ADVISORY,),
            ),
        ),
        (BASELINE, stale.to_owned()),
        ("crates/a/src/x.rs", "old_table\n".to_owned()),
    ]);
    let forms: [&[&str]; 2] = [
        &["--write-baseline=pattern_ratchet.bar"],
        &["--write-baseline"],
    ];

    for args in forms {
        let renamed = run(ws.path(), args);

        assert_eq!(renamed.code, 2, "{args:?}: {}", renamed.stdout);
        assert!(
            renamed.stderr.contains(
                "[pattern_ratchet.foo] names no instance in ARCHITECTURE.toml; remove that \
                 table, or rename it if the instance was renamed"
            ),
            "{args:?}: {}",
            renamed.stderr
        );
        assert_eq!(fs::read_to_string(ws.path().join(BASELINE)).unwrap(), stale);
    }

    fs::remove_file(ws.path().join(BASELINE)).unwrap();
    for args in forms {
        let missing = run(ws.path(), args);
        assert_eq!(missing.code, 2, "{args:?}: {}", missing.stdout);
        assert!(
            missing
                .stderr
                .starts_with("archcheck: error: could not read ")
                && missing.stderr.contains("architecture-baseline.toml"),
            "{args:?}: {}",
            missing.stderr
        );
        assert!(!ws.path().join(BASELINE).exists(), "{args:?}");
    }
}

/// A table is only taken as `--write-baseline=<table>`: `--write-baseline`
/// alone is the unscoped write, whatever follows it, and an argument after it
/// that is not a flag is an error rather than a table, with a hint unless
/// `=` already named one.
#[test]
fn write_baseline_takes_a_table_only_after_equals() {
    let ws = workspace(&[("ARCHITECTURE.toml", old_tables_config(ADVISORY))]);
    let baseline = ws.path().join("architecture-baseline.toml");
    let archcheck = |args: &[&std::ffi::OsStr]| {
        let output = Command::new(env!("CARGO_BIN_EXE_archcheck"))
            .args(args)
            .output()
            .expect("run archcheck");
        Run {
            code: output.status.code().expect("an exit status"),
            stdout: String::from_utf8(output.stdout).expect("UTF-8 stdout"),
            stderr: String::from_utf8(output.stderr).expect("UTF-8 stderr"),
        }
    };

    for table in ["file_size", "pattern_ratchet.old"] {
        let before = fs::read_to_string(&baseline).unwrap();
        let failed = run(ws.path(), &["--write-baseline", table]);
        assert_eq!(failed.code, 2, "{table}: {}", failed.stdout);
        assert!(
            failed.stderr.starts_with(&format!(
                "archcheck: unexpected argument {table:?}; name a table as \
                 --write-baseline={table}\nusage: archcheck "
            )),
            "{table}: {}",
            failed.stderr
        );
        assert_eq!(failed.stdout, "", "{table}");
        assert_eq!(fs::read_to_string(&baseline).unwrap(), before, "{table}");
    }
    let before = fs::read_to_string(&baseline).unwrap();
    let failed = run(ws.path(), &["--write-baseline=file_size", "extra"]);
    assert_eq!(failed.code, 2, "{}", failed.stdout);
    assert!(
        failed
            .stderr
            .starts_with("archcheck: unexpected argument \"extra\"\nusage: archcheck "),
        "{}",
        failed.stderr
    );
    assert_eq!(fs::read_to_string(&baseline).unwrap(), before);

    let unscoped = [
        archcheck(&[
            "--root".as_ref(),
            ws.path().as_os_str(),
            "--write-baseline".as_ref(),
            "--format".as_ref(),
            "human".as_ref(),
        ]),
        archcheck(&[
            "--write-baseline".as_ref(),
            "--root".as_ref(),
            ws.path().as_os_str(),
        ]),
    ];
    for run in unscoped {
        assert_eq!(run.code, 0, "{}", run.stderr);
        assert!(
            run.stdout
                .starts_with("archcheck: wrote 0 file_size entries to ")
                && !run.stdout.contains("other tables kept"),
            "{}",
            run.stdout
        );
    }
}

/// A configured instance without a baseline table tolerates nothing, as with
/// an empty table.
#[test]
fn pattern_ratchet_without_a_baseline_table() {
    for (text, expected) in [("old_table\n", 1), ("old_tables\n", 0)] {
        let found = |baseline: String| {
            let ws = workspace(&[
                ("ARCHITECTURE.toml", old_tables_config(ADVISORY)),
                ("architecture-baseline.toml", baseline),
                ("crates/b/src/sub/new.rs", text.to_owned()),
            ]);
            ratchet_findings(ws.path())
        };

        let without_table = found(baseline(&[]));

        assert_eq!(
            without_table.len(),
            expected,
            "{text:?}: {without_table:#?}"
        );
        assert!(
            without_table
                .iter()
                .all(|(code, _)| code == "pattern_ratchet.old.no_crossing")
        );
        assert_eq!(without_table, found(ratchet_baseline(&[("old", &[])])));
    }
}

/// Instance names are lowercase ASCII letters, digits and underscores,
/// starting with a letter.
#[test]
fn pattern_ratchet_instance_names() {
    let cases = [
        ("a", true),
        ("a_2", true),
        ("old_tables", true),
        ("a-b", false),
        ("2a", false),
        ("", false),
        ("A", false),
        ("a.b", false),
        ("_a", false),
    ];
    for (name, accepted) in cases {
        let ws = workspace(&[(
            "ARCHITECTURE.toml",
            format!(
                "{}{}",
                config(ADVISORY),
                ratchet(&format!("{name:?}"), &["x"], &[], ADVISORY,),
            ),
        )]);

        let loaded = Context::load(ws.path());

        match loaded {
            Ok(_) => assert!(accepted, "{name:?} was accepted"),
            Err(error) => {
                let error = error.to_string();
                assert!(!accepted, "{name:?}: {error}");
                assert!(
                    error.contains(&format!("instance name {name:?} must be")),
                    "{name:?}: {error}"
                );
            }
        }
    }
}

/// An invalid regex or glob is reported at its line and column in
/// `ARCHITECTURE.toml`.
#[test]
fn pattern_ratchet_errors_point_at_the_line() {
    let cases = [
        (
            &["(old_table"][..],
            &[][..],
            "patterns",
            "regex parse error",
        ),
        (
            &["old_table"][..],
            &["crates/{a"][..],
            "allow",
            "error parsing glob",
        ),
    ];
    for (patterns, allow, key, problem) in cases {
        let text = format!(
            "{}{}",
            config(ADVISORY),
            ratchet("old", patterns, allow, ADVISORY),
        );
        let line = 1 + text
            .lines()
            .position(|line| line.starts_with(&format!("{key} = ")))
            .unwrap();
        let column = key.len() + " = ".len() + 1;
        let ws = workspace(&[("ARCHITECTURE.toml", text)]);

        let error = Context::load(ws.path()).unwrap_err().to_string();

        assert!(
            error.contains(&format!("at line {line}, column {column}")),
            "{key}: {error}"
        );
        assert!(error.contains(problem), "{key}: {error}");
    }
}
