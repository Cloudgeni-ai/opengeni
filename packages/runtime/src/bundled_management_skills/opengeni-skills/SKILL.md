---
name: opengeni-skills
description: Find, install, create, and edit workspace Skills; understand reading, file changes, Learning modes, and optional sandbox checkout.
---

# Managing Skills

A Skill is a folder containing `SKILL.md` and supporting UTF-8 text files.
Use Skills for reusable instructions and procedures. Use Memory for facts and
outcomes, and workspace instructions for short always-on rules.

## Read

`skill_read` works without a sandbox. Omit `paths` to read `SKILL.md`; specify
relative paths to read exactly those files. Include `SKILL.md` explicitly only
when you want it alongside other files. An empty paths list is not a default.
Read supporting files only when needed. Reads return current saved content;
you do not need to pin a version to follow a Skill.

To discover supporting files, call `skill_read` with `listFiles: true` and no
`paths`. This returns only relative `paths` (at most 128) and available revision
identity, never file bodies. Then request only the paths you need. Inventory
cannot be combined with `paths` and does not require sandbox checkout.

## Find and install

Management tools are lazy: discover the relevant tool with tool search before
calling it. Use `skill_search` to find installed or available Skills and
`skill_install` to install a chosen source. Installation resolves source bytes
on the server; do not invent a source hash. Search does not install anything.
Installed guidance never grants credentials, tools, or additional permissions.
Keep the same `operationId` and original arguments when retrying an uncertain
install. A committed install replays before fetching the source again. Updates
must supply the reviewed installation version; do not substitute a newer value
merely to get past a conflict.

A skills.sh URL must match the current `SKILL.md` frontmatter name, not merely
the folder basename. If a link is stale or ambiguous, check the current name or
use the exact GitHub folder URL (`https://github.com/owner/repo/tree/ref/path`).

## Create and edit

Use `skill_save` for small changes to any text file, not only `SKILL.md`.
Every Skill requires `name` and `description` in `SKILL.md` YAML frontmatter.
That file is the source of truth: edit its frontmatter to change how the Skill
appears in the index. There is no separately editable short description. Saves
derive the index metadata from the same revision; supporting-file edits leave
it unchanged. Invalid or missing frontmatter is an error, not a fallback.
Choose a fresh UUID `skillId`, set `expectedRevisionId` to null and
`expectedScopeVersion` to 1, and retain the operation id for retries.
Keep the main instructions focused; place longer references or scripts in
supporting files. Text files may have any extension or no extension.

Supply only files being changed. Omitted files are preserved; deletion must be
explicit. Read existing content before editing it. If a save reports a stale
edit, re-read and reconcile the change instead of forcing an overwrite.

Use `skill_checkout` only when you need files on disk, for example to run a
script or edit a larger directory. Edit with ordinary filesystem tools, then
use `skill_publish` to save the directory. Do not repeat the whole folder's
contents in a tool argument. Checkout alone does not publish changes.
Stop processes editing the directory before publishing it. Publishing reads the
whole folder; server revision checks prevent overwriting a newer saved revision,
but they do not freeze a directory another process is changing.

## Persistent changes

Shared workspace Skills are available to workspace agents. Learning mode
governs persistent changes: Off refuses them; Require approval leaves a change
inactive; Autonomous makes an authorized valid change live. An agent saying
“the user asked” does not bypass the mode. Report whether the change is pending
or live. Do not change Learning settings to make a save succeed.

Saved history supports restoration. Upstream updates must preserve workspace
customizations; report an available update instead of replacing customized
content silently. Platform-owned built-in Skills are not workspace-editable.

Do not encode binary files as text to bypass the text-only boundary. Unsupported
files and size limits are explicit errors, not permission to drop files silently.
## One chat approval

When save, publish, or install returns `humanInput`, call
`request_human_input` with that exact payload. The card displays the complete
immutable Skill files. The initiating human's Save activates that exact revision
in the response transaction, before the session resumes. No follow-up activation
tool or second review is needed. Don't save and Other do not activate the Skill.
If the Skill changes before Save, make a new proposal for a fresh decision.
Autonomous saves return applied and need no confirmation. Off refuses durable
agent changes.
