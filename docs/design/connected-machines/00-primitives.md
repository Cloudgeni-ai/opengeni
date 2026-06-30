# Connected Machines — Primitives (v0 proposal, orchestrator-owned)

Grounds: the sandbox-vs-machine map (see brief). Today self-hosted compute is an
OVERLAY (`active_sandbox_id` pointer) on a mandatory Modal "home box"; a machine
session still provisions a Modal lease, fakes a `/workspace` root, and can clone a
repo into the user's real filesystem. This redesign makes a machine a first-class
compute target.

## The split — one `ComputeTarget` choice with two kinds
- **Managed Sandbox** — ephemeral, *platform-owned*. Platform provisions (clones
  repos into `/workspace`) and tears down. (today's modal/docker/local/…)
- **Connected Machine** — persistent, *user-owned*. Platform ATTACHES to what's
  already there; never provisions, clones, or tears down; uses the machine's OWN
  git auth.

They are SIBLINGS under one top-level choice — not a backend overlay on a
mandatory cloud box.

## Decisions (D#)
- **D1 — Machine is the session's PRIMARY compute, not an overlay.** A
  machine-bound session has NO home Modal box. Kills the manifest/env-parity hack,
  the rival-cold-recreate guard, and the `/workspace` virtual root at the root.
  *(Core refactor.)*
- **D2 — No token distribution to machines.** Skip the per-turn GitHub
  installation-token mint + `GH_TOKEN`/askpass/`http.extraheader` env injection for
  a machine target. The machine uses its own git auth (ssh / `gh` / credential
  helper). *(User call: when a machine has NO git auth → v1 = detect + surface a
  hint, don't manage it.)*
- **D3 — Repo selection is grayed for a machine.** No clone. A Project may DISPLAY
  its repo (derived from `git remote`), read-only — never to clone.
- **D4 — The work unit is a Project / Path.** A Project = a named registered path
  on a machine (optionally knows its repo for display). A machine has a default
  ROOT (the agent's launch dir) + zero-or-more named Projects (sub-paths). A session
  binds to: machine + a working path (Project / root / sub-folder).
- **D5 — Per-session working directory.** Today the agent cwd is fixed at launch
  (`std::env::current_dir`). A machine session must specify the working path → add a
  per-session `working_dir` to the agent protocol + `session_create`. This REPLACES
  the leaky `/workspace` virtual root (root = the chosen path, agent-reported).
  *(Core: agent protocol + runtime change.)*
- **D6 — Worktrees are an AGENT concern.** Platform gives a working path +
  fs/git/exec; the agent makes worktrees (orchestrator-at-root →
  worktree-per-subagent). Sub-agent sessions bind via `session_create.workingDir` =
  the worktree path. No platform worktree primitive.
- **D7 — Multi-session on one machine** = multiple working paths/worktrees, isolated
  by directory; the agent multiplexes (already does over NATS). Deeper isolation
  (resource limits, separate processes) = future.

## Session binding (tool + UI must match)
- `session_create`: a `computeTarget` (managed sandbox | machine id) + for a
  machine, a `workingDir` (host path / Project). Repos attached to a machine session
  do NOT clone.
- UI composer: compute-target is the FIRST, top-level choice and GATES everything.
  Sandbox → repo + branch (workdir `/workspace`). Machine → Project/path picker
  (repo grayed, optional sub-folder).

## Concrete bug to fix now (independent of the big refactor)
`repositoryUsesSandboxClone` (`packages/runtime/src/index.ts:2068`) gates the clone
on `settings.sandboxBackend` (the HOME box), so a machine-targeted session carrying a
private GitHub-App repo (`githubInstallationId` + `githubRepositoryId`) runs the
`beforeAgentStart` clone hook and `git clone`s into the user's REAL filesystem at the
agent's launch dir. **Fix: never clone onto a selfhosted active target.**

## Staging (smallest-correct first)
1. **Safe now (no big refactor):** clone-gating footgun fix; macOS metrics fix;
   install.sh no-token honesty; enroll dialog zero-click default.
2. **Core refactor (needs sign-off):** machine as primary compute (D1) + skip the
   token path (D2) + per-session `working_dir` (D5) + drop the `/workspace` virtual
   root for machines.
3. **Product surface:** Project primitive + registry (D4); composer redesign;
   session_create `computeTarget`/`workingDir`.

## Open calls for the user
- (a) Machine with no git auth → v1 = detect + hint, don't manage. OK?
- (b) Project creation: UI (register a path) AND an agent tool — or start with a
  free-form `workingDir` + named Projects as sugar?
- (c) Should a machine session ever accept a platform-cloned repo (into the machine's
  workspace)? Default NO. Confirm.
- (d) "[Pasted text #1]" (your path/project example) never came through — resend.
