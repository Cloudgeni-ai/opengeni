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

## Find and install

Management tools are lazy: discover the relevant tool with tool search before
calling it. Use `skill_search` to find installed or available Skills and
`skill_install` to install a chosen source. Installation resolves source bytes
on the server; do not invent a source hash. Search does not install anything.
Installed guidance never grants credentials, tools, or additional permissions.

## Create and edit

Use `skill_save` for small changes to any text file, not only `SKILL.md`.
Creating a Skill requires a `SKILL.md` with a useful name and description.
Keep the main instructions focused; place longer references or scripts in
supporting files. Text files may have any extension or no extension.

Supply only files being changed. Omitted files are preserved; deletion must be
explicit. Read existing content before editing it. If a save reports a stale
edit, re-read and reconcile the change instead of forcing an overwrite.

Use `skill_checkout` only when you need files on disk, for example to run a
script or edit a larger directory. Edit with ordinary filesystem tools, then
use `skill_publish` to save the directory. Do not repeat the whole folder's
contents in a tool argument. Checkout alone does not publish changes.

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