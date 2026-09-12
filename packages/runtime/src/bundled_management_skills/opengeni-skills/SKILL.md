---
name: opengeni-skills
description: Find, install, create, and edit workspace Skills; understand reading, file changes, Agent learning settings, and optional sandbox checkout.
---

# Managing Skills

A Skill is a folder containing `SKILL.md` and supporting UTF-8 text files.
Use Skills for reusable instructions and procedures. Use Knowledge for facts and
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

Facts and incidents belong in `knowledge_save`, with exact evidence and relevant
collections. Search published and pending Knowledge before adding duplicates.
Pending findings may inform further investigation but are not accepted facts or
permission to change a Skill. Use the current Skill content and its revision
when proposing procedural changes.

## Persistent changes

Shared workspace Skills are available to workspace agents. Private chats and
Personal workspaces save personal Skills for their verified initiating user.
Settings > Agent learning controls persistent agent changes, with a sparse chat
or scheduled-task override when configured. Automatic publishes a valid authorized
change; Review first saves an inactive revision and the task continues; Off
prevents agent authoring. Existing Skills remain readable and usable, and an
authorized human can still manage or install Skills in the UI. Do not change
settings or infer an override from “the user asked.” Report the actual receipt.

Saved history supports restoration. Upstream updates must preserve workspace
customizations; report an available update instead of replacing customized
content silently. Platform-owned built-in Skills are not workspace-editable.

Do not encode binary files as text to bypass the text-only boundary. Unsupported
files and size limits are explicit errors, not permission to drop files silently.
## Nonblocking review

A pending save, publish, or install is retained in Knowledge > Needs review.
Continue the task and link the pending revision. Do not call request_human_input
or a second activation tool to turn a pending receipt into a chat interruption.
The human reviews the exact revision in the shared review surface. Approval
publishes it; rejection leaves any previously published revision in place. A
stale review cannot overwrite a newer revision. Automatic receipts are available
immediately; Off creates no durable agent change.
