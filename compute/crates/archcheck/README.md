# archcheck

`archcheck` checks the compute workspace's structure rules in
[`ARCHITECTURE.toml`](../../ARCHITECTURE.toml). Existing violations a rule
tolerates for now are listed in
[`architecture-baseline.toml`](../../architecture-baseline.toml).

It is SPACE's archcheck (<https://github.com/perplexityai/SPACE>,
`crates/tools/archcheck` at `c788098f`, Copyright 2026 Perplexity AI,
Apache-2.0), changed for this workspace: the package is renamed, its
dependencies carry their own versions, and a `<dir>/*` workspace member is
expanded to the directories in `<dir>` instead of rejected. See
[`NOTICE`](../../NOTICE).

```sh
cargo arch                           # human-readable report, compared with the [base] branch
cargo arch --format rdjson           # reviewdog Diagnostic Format, for CI
cargo arch --base-baseline <path>    # compare with this copy of the base branch's baseline
cargo arch --no-base                 # skip that comparison, as when the baseline is new
cargo arch --write-baseline          # lower or remove the baseline's entries; never adds or raises one
cargo arch --write-baseline=<table>  # update one table's entries, keeping the others
cargo arch --root <path>             # check another checkout
```

Without `--root`, it checks the Cargo workspace containing the current
directory. Exit status: 0 without required findings, 1 with one, 2 for a
configuration, usage or I/O error.

Workspace members come from the root `Cargo.toml`. A member written as
`<dir>/*` stands for every directory directly inside `<dir>`, as Cargo expands
it: files there are skipped, and a directory without a `Cargo.toml` is a
missing member (exit 2). No other glob is accepted.

## What is checked

- **Production Rust file:** a `.rs` file under `<member>/src/` of a workspace
  member in the root `Cargo.toml`, except `tests.rs`, `*_tests.rs` and
  anything below a `tests/` directory. Symlinks under `src/` are skipped; a
  member directory or `src` that is itself a symlink is followed. Other files
  may have non-UTF-8 names; a `.rs` file may not (exit 2).
- **Code line:** a line that is not blank and does not start with `//` after
  trimming. Lines end at LF or CRLF, as they do for rustc's `//` comments and
  line numbers, so a file with only CR line breaks is one line (`rustfmt
  --check` rejects such files). A leading byte order mark is ignored. Block
  comments and attributes count.

`file_size` limits production files to `limit` code lines, with five
behaviours:

- `no_crossing`: a file outside the baseline is over the limit;
- `no_new_entries`: the baseline has an entry that the base branch's copy
  lacks (a renamed file counts as added);
- `no_raised_caps`: an entry's cap is higher than in the base branch's copy;
- `listed_no_growth`: a listed file grew past its cap;
- `stale_entries`: an entry can be lowered or removed, because its file shrank,
  is at or under the limit, or no longer exists (or the key names no
  production file).

`no_new_entries` and `no_raised_caps` compare with the base branch's copy of
the baseline, so that the baseline is no way around the limit. By default
archcheck reads that copy with git: the `[base] branch` in
`ARCHITECTURE.toml`, at its merge base with `HEAD`, so a cap the base branch
lowered after this branch forked is not taken for one this branch raised. A
base with `ARCHITECTURE.toml` but no baseline file tolerates nothing; a base
without `ARCHITECTURE.toml` has not adopted archcheck, so the branch that
introduces it skips these comparisons and says so. A branch that cannot be
resolved exits 2, saying to fetch it, give `--base-baseline <path>`, or skip
the comparison with `--no-base`.
Lowered caps and removed entries are silent. Only that copy's `[file_size]`
table is read here, and other tables and keys are ignored, so a pull request
can change the baseline's schema. If the copy can't be read, archcheck exits 2.
If it isn't TOML, or its `[file_size]` isn't a table of integers, both
behaviours are skipped with a warning. Without the flag (the local default)
they are skipped too. Either way, one line after the summary line says so: on
stdout for `human`, on stderr for `rdjson`.

`pattern_ratchet` is a lint: it counts, per production file, the code lines
that mention a name, and ratchets those counts. It has any number of named
instances, each with its own patterns, allowed paths, modes and baseline
table:

```toml
[rules.pattern_ratchet.<instance>]
patterns = ['\bsome_name\b']     # regexes, matched against each code line
allow = ["crates/x/src/owner.rs", "crates/x/src/owner/**"]

[rules.pattern_ratchet.<instance>.no_crossing]
mode = "advisory"
# ...and no_new_entries, no_raised_caps, listed_no_growth and stale_entries,
# as for file_size
```

It counts mentions, not uses. A code line matches if any pattern matches
anywhere in it, so a string literal, an error message, a log line or a
trailing comment that only names an identifier counts the same as code that
uses it; several matches on one line count once. A name built at run time,
such as with `format!`, does not match, and only production `.rs` files are
read, so text in other files under `src/`, such as SQL loaded with
`include_str!`, is not counted either; moving a match into such a file shows
up as a `stale_entries` finding on the file it left, not a `no_crossing` one.
Nor are files outside workspace members' `src/` read, such as lab scripts
or integration tests. Use `\b` around a
name so that longer identifiers containing it do not match. Patterns are
case-sensitive unless they use an inline `(?i)` flag. `allow` globs match
repository-relative paths: `*` and `?` stay within one path component and
`**` spans any number. Files they match are never counted.

- `no_crossing`: a file outside the allowed paths and the instance's baseline
  table has a matching line;
- `no_new_entries`: the instance's table has an entry that the base branch's
  copy of that table lacks (a renamed file counts as added);
- `no_raised_caps`: an entry's cap is higher than in the base branch's copy
  of the table;
- `listed_no_growth`: a listed file has more matching lines than its cap;
- `stale_entries`: an entry can be lowered or removed, because its file has
  fewer matching lines, none, is now allowed, or no longer exists.

`no_new_entries` and `no_raised_caps` compare with the base branch's copy as
`file_size`'s do. Each instance reads only its own `[pattern_ratchet.<instance>]`
table from that copy, leniently: a table for an instance that is not
configured, such as one this pull request renamed or removed, is ignored, with
a line after the summary (`base baseline has [pattern_ratchet.<instance>],
which is not configured; skipped`) so that the removal shows in the log; a
missing table has no entries, so every entry of the instance's own table is
new. If the instance's table, or `pattern_ratchet` itself, isn't a table of
integers, that instance's two behaviours are skipped with a warning, and the
other tables are still compared. If the copy isn't TOML at all, one warning
line names every comparison skipped, `file_size`'s and each instance's.
With `--no-base`, or without a `[base]` branch or `--base-baseline`, they are
skipped, one line per instance after the summary line. Loosening an instance in
`ARCHITECTURE.toml`, by widening `allow` or narrowing `patterns`, is not
reported by any behaviour: review such changes.

An instance name is lowercase ASCII letters, digits and underscores, starting
with a letter. Adding an instance takes configuration and a baseline table, no
code changes:

1. Add its tables to `ARCHITECTURE.toml`, with a comment saying why.
2. Run `cargo arch --write-baseline=pattern_ratchet.<instance>`. The baseline
   has no table for the instance, so it is left alone, and the command lists
   every file outside the allowed paths that matches today as `not added`,
   followed by those entries as TOML.
3. Add the table to `architecture-baseline.toml` by hand: paste the listed
   entries, or, if no file matches, add an empty `[pattern_ratchet.<instance>]`
   or none at all. Review each entry.
4. Commit both files. On the pull request, `no_new_entries` reports each
   entry, since the base branch's copy has no table for the instance: that is
   expected for a deliberate new instance.

## Configuration and modes

Each behaviour has a `mode`: `advisory` findings are reported, `required` ones
also fail the check, so behaviours can graduate one at a time. Unknown keys,
sections or modes, a missing file, bad TOML, an invalid regex, glob or instance
name, an empty `patterns` list, a baseline table for an instance that is not
configured, and `members` with globs other than a trailing `/*` or with
empty, `.` or `..` components exit 2. So does a `--base-baseline` that can't
be read, or one combined with `--write-baseline`.

## Baseline

Each table maps a repository-relative path to its cap, the count it had when
listed: under `[file_size]`, each production file over the limit, with its
code-line count; under `[pattern_ratchet.<instance>]`, each production file
outside the instance's allowed paths with a matching line, with its count of
matching lines. Entries should only be removed or lowered.

`cargo arch --write-baseline` rewrites `architecture-baseline.toml` from its
entries and the tree. An entry still in violation gets its current count as
its cap when that is lower, and keeps its cap otherwise: under `[file_size]`,
a file still over the limit; under
`[pattern_ratchet.<instance>]`, a file outside the allowed paths that still has
a matching line. The other entries are removed. It never adds an entry, or a
`[pattern_ratchet.<instance>]` table the file lacks (`[file_size]` is always
written, empty if the file had none). It prints `not added: <path> (N code lines); …` for each
file over the limit without an entry instead, and `not added: <path> (N code
lines matching the <instance> patterns); …` for each matching file without
one, and `not raised: <path> (…, cap N); …` for each listed file that grew
past its cap, then, after its summary line, the entries they would need, as TOML, one
block per table, each after a comment saying where it goes. For a table the
file has, the block has no header and its comment says to add the entries
inside that table, below its header: pasted at the end of the file, they would
land in whichever table comes last. For a table the file lacks, the block
starts with the table's header and goes at the end of the file. Fix the file,
or, for a deliberate exception, add the entry or raise the cap by hand, inside
its table, which `no_new_entries` or `no_raised_caps` then reports. It reads the
existing file with the strict parser, so a missing or invalid baseline exits 2:
it can't create one from scratch.

`cargo arch --write-baseline=<table>`, with `<table>` either `file_size` or
`pattern_ratchet.<instance>` for a configured instance, does the same for that
table alone and keeps every other table as the existing baseline has it,
printing only that table's `not added` lines and entries. Use it when adding
or changing one rule, so that other tables are left alone. If the file has no
`[pattern_ratchet.<instance>]` table for it, the table is not created and the
file is left alone (see adding an
instance, above). Other tables come out byte-identical if the file is in
generated form (as written by archcheck); hand-added comments, quoting or key
order are normalized. As for the unscoped form, the existing baseline must
exist and pass the checks `cargo arch` makes, including that every
`[pattern_ratchet.<instance>]` table names a configured instance; otherwise, as
for an unknown table, it exits 2 and leaves the file alone. The table is only
taken after `=`: `--write-baseline` alone is always the unscoped write, and an
argument after it that is not a flag is a usage error.

The inventory walks the filesystem, so untracked `.rs` files under `src/` are
counted too: check `git status` before `--write-baseline`.

## Before merging

`cargo test -p compute-archcheck` runs `tests/repository.rs`, which fails on
any required finding anywhere in the tree that needs no base. `cargo arch`
also fails on what a branch adds to the baseline or raises in it, compared
with the `[base]` branch; fetch that branch first.

`--format rdjson` gives the findings in reviewdog's format for CI annotations.
Each finding is a diagnostic with code `<rule>.<behaviour>`, or
`<rule>.<instance>.<behaviour>` for a rule with instances, on line 1 of its
file, with the path exactly as it is. A new entry, a raised cap, and a stale
entry for a deleted file point at the entry's line in the baseline instead.
`pattern_ratchet`'s `no_crossing`, `listed_no_growth` and shrank
`stale_entries` findings point at the file's first matching line; one for a
file with no matches left, at its line 1. Required findings are `ERROR`,
advisory ones `WARNING`.

## Adding a rule

A new instance of `pattern_ratchet` is configuration, not a new rule (see
above). For a new kind of check:

1. Add a module under `src/rules/`. A rule that caps a count per file in a
   baseline table, as both rules do, implements `CountRule`
   (`src/rules/ratchet.rs`): one `CountRatchet` per table, whose `measure`
   gives a violating file's count and the line findings about it point at,
   and whose wording the findings and `not added` lines are built from. The
   five behaviours, finding locations, the comparisons with the base
   branch's copy, the skip lines, and `--write-baseline` (update or remove,
   never add) come with it. Any other check implements `Rule`; if it has a
   baseline table, it also implements `Rule::tables`, without which the
   baseline's table is rejected as naming no instance, and
   `Rule::update_baseline`, which never adds an entry; if it compares with
   the base branch's copy, `Rule::baseline_rule`, `Rule::skipped` and
   `Rule::base_comparisons` too: without `Rule::baseline_rule`, a table
   `Baseline::load_base` does not read gets skip lines, not exit 2.
2. Add its configuration to `RulesConfig` in `src/config.rs`, with one
   `BehaviourConfig` per behaviour, and its table to `ARCHITECTURE.toml`.
3. For a rule with a baseline table, in `src/baseline.rs`:
   - add a `#[serde(default)]` field to `BaselineFile`, read into the tables
     in `Baseline::from_file` under the rule's name (`BaselineFile` denies
     unknown fields, so a table it does not know makes the next check exit
     2);
   - read the rule's own key from the parsed document in
     `Baseline::load_base`, on its own, as for `pattern_ratchet`, and record
     the rule as read; a registered rule that is not read makes every
     `--base-baseline` run whose base copy is TOML exit 2. Do not add a
     field to `BaseBaselineFile`, which reads `[file_size]` alone: a second
     field there would let one table that does not parse skip both rules'
     comparisons;
   - describe the table in the generated header, `HEADER`.
4. Register it in `rules::registered()` and add test cases to `tests/cli.rs`.
