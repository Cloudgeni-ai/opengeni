# Connected Machines — Composer / Session-Setup UX Redesign (v0, orchestrator-owned)

Grounds: `00-primitives.md` (source of truth; this UX implements it), the COMPOSER +
BINDING map sections, and the requirements brief (item D). All file:line citations are
against this `machines-hacks` worktree, which is **up to date with origin/main** — it
already has the `selfhosted` backend (`packages/contracts/src/index.ts:18-31`), the
`CAPABILITY_DESCRIPTORS` table (`:101`), the `MachineView` contract (`:3161`), and a
Machine `<select>` in the composer (`apps/web/src/routes/sessions-index.tsx:250-263`).

> Scope: this is a DESIGN doc. No code edits. It defines the redesigned model, the
> wireframes, the gating state machine, the component/state restructure, and the
> migration path (additive-first → full redesign).

---

## 0. What exists today (verified) — and why it is worse than the brief described

The brief said the compute target is "a flat `sandboxBackend` `<select>` buried in a
collapsed disclosure." That is still true, but the machine-targeting work landed on top
**without fixing the shape** — it made it worse by adding a *second, overlapping* compute
control as yet another independent sibling:

`apps/web/src/routes/sessions-index.tsx`:
- `SessionControlStrip` (`:151-199`) — always-visible inline pills: `ModelPicker`,
  `RepositoryContextPicker` (repos — which only make sense once compute exists),
  `EnabledMcpToolPicker`.
- `AdvancedSessionOptions` (`:201-388`) — a **collapsed "Session setup" disclosure**
  (`advancedOpen` defaults `false`, `:52`) that now contains *three* orthogonal compute-ish
  controls stacked as siblings:
  1. **Machine `<select>`** (`:250-263`) — "Cloud sandbox" vs an enrolled selfhosted
     machine; threaded as `targetSandboxId` (a top-level `CreateSessionRequest` field that
     seeds the *active-sandbox overlay pointer*, `session-create.ts:9-11`).
  2. **Environment `<select>`** (`:273-285`) — "Variables are injected into the sandbox at
     start" (`:286-288`).
  3. **Sandbox-backend override** (`:294-319`) — nested one level *deeper* inside a
     `<details>`, a hand-maintained 5-item literal `sandboxBackendOptions` (`:39-45`) that
     sets the session's **home box** backend.

So there are now **two compute controls that mean different things** (the Machine picker =
an *overlay* on a mandatory home box; the backend override = the *home box itself*) and the
UI presents them as unrelated siblings. This is the exact "machine is an overlay on a
mandatory cloud box" conflation `00-primitives.md` D1 exists to kill — surfaced verbatim in
the form.

### The two split stores (still split)

1. **Global app context** (`apps/web/src/context.tsx`): `model` (`:163`), `reasoningEffort`
   (`:168`), `manualRepos` (`:171`), `selectedRepoIds` (`:174`), `selectedRepoRefs`
   (`:175`), `selectedCapabilityToolIds` (`:181`). Workspace-sticky; **shared with the
   in-session strip** (`session.tsx:399-413`).
2. **Local `advanced: AdvancedSessionDraft`** (`sessions-index.tsx:53`; shape in
   `apps/web/src/lib/session-create.ts:6-19`): `targetSandboxId`, `sandboxBackend`,
   `environmentId`, `goalText/goalSuccessCriteria/goalMaxAutoContinuations`,
   `customMcpPermissions`, `mcpPermissions`. **Reset to `emptyAdvancedSessionDraft()` on
   every mount** (`:53`).

Payload assembly is two-stage and crosses the stores only at submit:
`submissionExtrasFromAdvancedSessionDraft(advanced)` (`session-create.ts:42-57`) +
`targetSandboxIdFromAdvancedSessionDraft(advanced)` (`:37-39`) → spread into
`context.startSession(...)` (`sessions-index.tsx:79-87`), which then merges the global
`model`/`reasoningEffort`/`tools`/`currentResources` (`context.tsx:444-463`).
`targetSandboxId` is cast through because the SDK request type doesn't surface it yet
(`context.tsx:460-462`).

### Nothing is gated on the compute choice

There is no `disabled`/hide branch keyed off the picked machine or backend anywhere. Pick a
selfhosted machine and the form *still* shows the full Repository picker (which would
`git clone` into the user's real disk — the `00-primitives.md` clone-gating footgun,
`packages/runtime/src/index.ts:2068`), the Environment injector ("injected into the
sandbox," meaningless for a user-owned machine that uses its own auth — D2), and offers no
folder/workdir at all (`workspaceRoot` is a per-backend constant: modal `/workspace`
`contracts:123`, selfhosted `/` `:398` — never user-selectable). Repo branch is buried
per-repo (`repository-picker.tsx:263-275`); there is no top-level branch.

**In-session asymmetry:** the in-session strip (`session.tsx:397-415`) shows only Model +
Tools; compute lives in a *separate* header pill `SessionSandboxSwitcher` ("Run on:",
`apps/web/src/components/session/sandbox-switcher.tsx`) that live-swaps via `attachMachine`;
the inspector shows a read-only `InfoRow label="Sandbox" value={session.sandboxBackend}`
(`apps/web/src/components/session/inspector.tsx:72`) — i.e. the **home backend**, NOT the
active machine, so a machine-targeted session reads "Sandbox: modal" while running on a
selfhosted box. Three different surfaces, three different mental models, none consistent
with the create form.

There is **no Project primitive and no `workingDir`/`workdir` field anywhere** (greenfield;
confirmed by grep — `00-primitives.md` D4/D5).

---

## 1. The redesigned model — one top-level `ComputeTarget` that GATES the form

The root question, per `00-primitives.md` and brief D, is **"Where should this run?"** — a
single first-class choice with exactly two *kinds* (siblings, not an overlay):

```
ComputeTarget
├── Managed Sandbox   (ephemeral, platform-owned — clones repos into workspaceRoot, tears down)
│      backend: deployment-default | <a specific managed backend>
└── Connected Machine (persistent, user-owned — platform ATTACHES; no clone, no teardown, machine's own auth)
       machine: <one enrolled selfhosted MachineView>
       project: root | named-project | host-path | + optional sub-folder
```

This choice is the **parent** that drives everything below it. It collapses BOTH of today's
overlapping compute controls into one: "Managed Sandbox" *is* the home-backend choice (the
old `sandboxBackend` override demoted to an Advanced detail *inside* this kind), and
"Connected Machine" *is* `targetSandboxId` (no separate overlay concept the user has to
reason about). The user never again picks "an overlay on a mandatory box."

### Data-driven from `CAPABILITY_DESCRIPTORS`

Both kinds are populated from data already in `packages/contracts/src/index.ts`, not
hand-maintained literals:

- **Managed Sandbox options** = `CAPABILITY_DESCRIPTORS` entries where
  `backend !== "selfhosted"` (`:101`). Default = deployment default (`sandboxBackend: ""`).
  Each option renders capability chips straight from its descriptor: `tier`
  (desktop/headless/dev), `capabilities.DesktopStream.available`,
  `capabilities.Recording.available`, `lifetime.hardLifetimeMs` (e.g. modal "Desktop ·
  Recording · 24h"). This replaces the 5-item `sandboxBackendOptions` literal
  (`sessions-index.tsx:39-45`) and finally surfaces the metadata the map flagged as ignored.
- **Connected Machine options** = `useMachines({ pollIntervalMs })` filtered to
  `kind === "selfhosted"` (already done at `sessions-index.tsx:212-213`). Selectability =
  `isMachineComputeSelectable(machine.state)` (`apps/web/src/lib/machine-selectability.ts:9`
  → `online || display_unavailable`). Each machine row shows live `MachineView` fields
  (`contracts:3161-3177`): `name`, `os`/`arch`, `hasDisplay`, `state`, `metrics`, plus the
  static `CAPABILITY_DESCRIPTORS.selfhosted` (`:371`) chips (FileSystem/Terminal/Git always;
  DesktopStream consent-gated).

### What each kind binds (the `00-primitives.md` mapping)

| Concern | Managed Sandbox | Connected Machine |
|---|---|---|
| Repo + branch | **Primary control** — clone source into `workspaceRoot` | **Grayed / read-only** (D3: no clone; may *display* a repo derived from `git remote`, never clone) |
| Workdir / folder | Fixed `workspaceRoot` (`/workspace`, info-only) | **Project / path picker** (D4): machine default root + named Projects + optional sub-folder (D5 `workingDir`) |
| Environment injection | Shown (vars injected at start) | **Hidden** — replaced by "uses this machine's own environment & git auth" (D2: no token mint, no env injection) |
| Backend override | Demoted to an Advanced detail *inside* this kind | n/a (kind *is* `selfhosted`) |
| Model / Tools / Goal / MCP perms | Shown, unchanged | Shown, unchanged (compute-independent) |

---

## 2. Wireframes — both states

The composer becomes top-down: **(A) message → (B) Where this runs → (C) compute-dependent
binding → (D) compute-independent options.** "Where this runs" is a top-level segmented
control, NOT a buried disclosure.

### State 1 — Managed Sandbox selected (default)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  What should the agent do?                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ Describe a task for the agent...                                  │     │
│  │                                                                   │     │
│  │  [Model ▾] [Tools ▾]                                    [ Send ⏎] │     │ ← strip: compute-independent
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│  WHERE SHOULD THIS RUN?                                                    │
│  ┌────────────────────────────┐ ┌────────────────────────────┐            │
│  │ ●  Managed Sandbox         │ │ ○  Connected Machine        │            │ ← TOP-LEVEL segmented (parent)
│  │    Ephemeral · we provision│ │    Your enrolled machines   │            │
│  └────────────────────────────┘ └────────────────────────────┘            │
│        │ (selected → gates ↓)                                              │
│        ▼                                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ Repository + branch                                               │     │ ← SHOWN (clone source)
│  │   [▣ acme/api   branch: main      ▾]  [+ add repo]                │     │
│  │   Folder:  /workspace            (sandbox root, fixed)            │     │ ← workdir = workspaceRoot, info-only
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ Environment   [ staging (4 vars) ▾ ]                             │     │ ← SHOWN (injected at start)
│  │   Variables are injected into the sandbox at start.              │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ ▸ Advanced: backend = Deployment default  ·  Desktop · Rec · 24h │     │ ← backend override DEMOTED here,
│  └──────────────────────────────────────────────────────────────────┘     │    chips from CAPABILITY_DESCRIPTORS
│                                                                            │
│  ▸ Goal · OpenGeni tool permissions               (collapsed, optional)   │ ← compute-INDEPENDENT options
└──────────────────────────────────────────────────────────────────────────┘
```

### State 2 — Connected Machine selected

```
┌──────────────────────────────────────────────────────────────────────────┐
│  What should the agent do?                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ Describe a task for the agent...                       [ Send ⏎]  │     │
│  │  [Model ▾] [Tools ▾]                                              │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│  WHERE SHOULD THIS RUN?                                                    │
│  ┌────────────────────────────┐ ┌────────────────────────────┐            │
│  │ ○  Managed Sandbox         │ │ ●  Connected Machine        │            │
│  └────────────────────────────┘ └────────────────────────────┘            │
│                                          │ (selected → gates ↓)            │
│                                          ▼                                 │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ Machine   [ jorgen-mbp  ·  macos/arm64 · ●online · no display ▾ ] │     │ ← PRIMARY control (MachineView)
│  │           FileSystem · Terminal · Git            (selfhosted caps)│     │ ← chips from CAPABILITY_DESCRIPTORS
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ Project / folder                                                  │     │ ← workdir picker (D4/D5)
│  │   ( ) Machine root  (the agent's launch dir)                      │     │
│  │   (●) Project:  opengeni   →  ~/repos/opengeni                    │     │
│  │   ( ) Custom path:  [ /Users/jorgen/...            ]              │     │
│  │   Sub-folder (optional):  [ packages/runtime        ]            │     │
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ ▨ Repositories                          (disabled on a machine)   │     │ ← GRAYED (D3: no clone)
│  │   This machine uses its own checkout & git auth.                  │     │
│  │   Detected remote: github.com/Cloudgeni-ai/opengeni  (display)    │     │ ← optional, from `git remote`, never cloned
│  ├──────────────────────────────────────────────────────────────────┤     │
│  │ ⌀ Environment injection — not used on a connected machine.        │     │ ← HIDDEN/replaced (D2)
│  │   The machine's own environment & git credentials apply.         │     │
│  └──────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│  ▸ Goal · OpenGeni tool permissions               (collapsed, optional)   │ ← UNCHANGED, compute-independent
└──────────────────────────────────────────────────────────────────────────┘
```

Legend: `▣`/`▨` = enabled/grayed control · `⌀` = removed-with-explanation · `▸` = collapsed
section. The only thing that *moves* between states is the compute-dependent band (the
middle card); the strip and the optional band are stable.

---

## 3. The gating state machine

`compute.kind` is the single discriminant. `compute.backend` (sandbox) and
`compute.machine.state` (machine) are secondary inputs to enable/disable *within* a kind.

```
                 ┌─────────────────────────────────────────────┐
                 │           ComputeTarget (parent)            │
                 └─────────────────────────────────────────────┘
                        │                          │
            kind = "sandbox"               kind = "machine"
                        │                          │
        ┌───────────────┴───────────┐   ┌──────────┴───────────────────────┐
        ▼                           ▼   ▼                                   ▼
  backend picker (Advanced)   repo+branch    machine picker            project/path picker
  default = "" (deploy default) SHOWN,       SHOWN (required to submit) SHOWN (default = root)
  options from                 enabled       options from              field from
  CAPABILITY_DESCRIPTORS,      (clone src)   useMachines(selfhosted),  selfhosted.workspaceRoot
  backend!=="selfhosted"                     gate=isMachineComputeSel.  + D5 workingDir
```

### Per-field reflow table (authoritative)

| Field | Source / file:line | `kind="sandbox"` | `kind="machine"` |
|---|---|---|---|
| Backend select | `sessions-index.tsx:39-45,294-319` | **shown** (Advanced detail), default = deployment default; options = managed descriptors | **hidden** (forced `selfhosted`) |
| Machine select | `sessions-index.tsx:250-263` | **hidden** | **shown** — primary; `disabled` per `isMachineComputeSelectable` (`machine-selectability.ts:9`); empty fleet → kind disabled with "enroll a machine" CTA |
| Repo + branch | `repository-picker.tsx:39`, `session-tools.ts:54` | **shown** (clone into `workspaceRoot`); promote a single primary repo+branch row | **grayed/read-only** (D3) — optional `git remote` display only; never assembled into `resources[]` for clone |
| Workdir / folder | new; driven by `workspaceRoot` (`contracts:123,398`) | **fixed** `/workspace`, info-only | **Project/path picker** (D4): root \| named project \| custom path \| + sub-folder → becomes `workingDir` (D5) |
| Environment injection | `sessions-index.tsx:273-288` | **shown** (injected at start) | **hidden**, replaced by "machine's own env/auth applies" (D2) |
| Model | `pickers.tsx`/strip | shown | shown (identical) |
| Tools | `EnabledMcpToolPicker` | shown | shown (identical) |
| Goal (+criteria/max-cont) | `sessions-index.tsx:326-349` | shown; criteria/max disabled until `goalText` (`:336-348`) | shown (identical) |
| MCP permissions | `sessions-index.tsx:352-383` | shown | shown (identical) |

### Transition rules

- **`sandbox → machine`**: hide backend+env; **keep** repo selection in state but stop
  contributing it to `resources[]` (so toggling back is lossless), render it grayed with the
  D3 explanation; reveal machine + project pickers; if no machine yet picked, **submit is
  blocked** with "choose a machine."
- **`machine → sandbox`**: hide machine+project pickers; re-enable repo (its preserved
  selection re-activates) and env; backend reverts to its last value (default deployment
  default).
- **Invalid states are unreachable by construction** (discriminated union), so there is no
  "machine + clone repo into my disk" path the user can assemble — which is the whole point
  of gating (and the UI half of the `repositoryUsesSandboxClone` footgun fix; the runtime
  half lands separately per `00-primitives.md`).
- **Submit mapping** (one place, replacing the two-stage spread):
  - `sandbox` → `sandboxBackend = backend || undefined`, `targetSandboxId = null`,
    `workingDir = undefined` (sandbox root is `workspaceRoot`).
  - `machine` → `targetSandboxId = machine.sandboxId`, `sandboxBackend = undefined`
    (until D1 drops the mandatory home box, the create still seeds one server-side; the UI
    no longer asks), `workingDir = resolvedProjectPath` (D5; until that field ships,
    `workingDir` is omitted and the agent runs at its launch root — see Migration).

---

## 4. Component tree + state restructure

### 4.1 Collapse the two stores into one `SessionDraft`

Replace the split between global-context selection fields and the per-mount
`AdvancedSessionDraft` with a single discriminated `SessionDraft` owned by one hook,
`useSessionDraft()`:

```ts
type ManagedSandboxTarget = {
  kind: "sandbox";
  backend: SandboxBackend | "";          // "" = deployment default
};
type ConnectedMachineTarget = {
  kind: "machine";
  sandboxId: string;                      // a selfhosted MachineView.sandboxId
  project:                                // the working path (D4/D5)
    | { kind: "root" }                    // agent's launch dir (workspace_root)
    | { kind: "project"; projectId: string } // a registered Project (named path) — D4, future
    | { kind: "path"; absolutePath: string }; // free-form host path
  subfolder?: string;                     // optional sub-path under the chosen base (D6: agent may still worktree)
};
type ComputeTarget = ManagedSandboxTarget | ConnectedMachineTarget;

type SessionDraft = {
  compute: ComputeTarget;                 // PROMOTED — the parent
  // repo selection is retained across kind toggles but only contributes resources when compute.kind==="sandbox"
  repos: { selectedRepoIds: Set<number>; selectedRepoRefs: Record<number,string>; manualRepos: RepoDraft[] };
  environmentId: string;                  // ignored when compute.kind==="machine"
  model: string; reasoningEffort: IntelligenceEffort;
  tools: Set<string>;
  goal: { text: string; successCriteria: string; maxAutoContinuations: string };
  mcp: { custom: boolean; permissions: Set<string> };
};
```

- **Persistence is now explicit, not accidental.** Today some fields are workspace-sticky
  (global context) and some evaporate per-mount (local advanced) with no signal to the user
  (map conflation #4). In `SessionDraft`, persistence is a declared concern: persist
  *last-used* `compute` + `model`/`tools` to `localStorage` (sticky is a feature for those),
  and treat `goal`/`environmentId`/`repos` as draft-scoped (cleared on submit). One rule,
  visible in one place.
- `targetSandboxId` stops being a special cast-through (`context.tsx:460-462`): it is just
  `compute.kind==="machine" ? compute.sandboxId : null` computed at the single submit
  mapper.

### 4.2 Component tree (new-session surface)

```
SessionsIndexRoute                                  (sessions-index.tsx:47)
└── useSessionDraft()                               ← NEW single store (replaces split)
├── ConsoleComposer  (controls = SessionControlStrip)
│   └── SessionControlStrip                         (:151) — compute-INDEPENDENT only
│         ├── ModelPicker                           (binds draft.model)
│         └── EnabledMcpToolPicker                  (binds draft.tools)
├── <ComputeTargetControl>                          ← NEW top-level, REPLACES the buried
│     ├── segmented: Managed Sandbox | Connected Machine        Machine/backend selects
│     ├── kind="sandbox"  → <ManagedSandboxFields>
│     │      ├── <RepositoryContextPicker>          (repository-picker.tsx:39 — promote primary repo+branch)
│     │      ├── workdir = workspaceRoot (info)
│     │      ├── <EnvironmentPicker>                (was sessions-index.tsx:273-285)
│     │      └── ▸ Advanced backend  (descriptor-driven, was :294-319)
│     └── kind="machine"  → <ConnectedMachineFields>
│            ├── <MachinePicker>                    (was sessions-index.tsx:250-263; chips from MachineView + descriptor)
│            ├── <ProjectPathPicker>                ← NEW (root | project | path | +subfolder)
│            ├── <RepositoryContextPicker disabled> (grayed; optional remote display — D3)
│            └── env-injection note (D2)
└── <OptionalSessionOptions>                        (collapsed) — compute-INDEPENDENT
      ├── Goal + criteria + max-continuations        (was :326-349)
      └── MCP permission scope                        (was :352-383)
```

`<ComputeTargetControl>` is a **shared component** used in three places so the strips are
consistent (map conflation #8):
1. **new-session** (here) — editable, gates the form;
2. **in-session header** — replaces the standalone `SessionSandboxSwitcher`
   (`sandbox-switcher.tsx`); shows the *active* target, allows the existing live swap
   (`attachMachine` / `SwapActiveSandboxRequest` `contracts:3198`);
3. **inspector** — the `InfoRow label="Sandbox"` (`inspector.tsx:72`) is changed to render
   the **active machine** (resolve `activeSandboxId`→`MachineView.name`) instead of the home
   `sandboxBackend`, so all three surfaces agree.

### 4.3 What gets deleted / replaced

- `sandboxBackendOptions` literal (`sessions-index.tsx:39-45`) → derived from
  `CAPABILITY_DESCRIPTORS` (managed subset).
- `AdvancedSessionDraft` + `emptyAdvancedSessionDraft` + the two mapper fns
  (`session-create.ts:6-57`) → folded into `SessionDraft` + one `submitMapper(draft)`.
- The collapsed "Session setup" disclosure (`AdvancedSessionOptions`, `:201-388`) is split:
  compute → top-level `<ComputeTargetControl>`; goal/MCP → `<OptionalSessionOptions>`.
- `SessionSandboxSwitcher` (`sandbox-switcher.tsx`) → its swap logic moves behind the shared
  `<ComputeTargetControl>` in-session variant.

---

## 5. Migration notes — additive-first, then the full redesign

Per `00-primitives.md §Staging` (smallest-correct first). The composer redesign decomposes
into PRs that ship value without waiting on the core refactor.

### PR 1 — pure-UI promotion + gating (additive, NON-breaking, no contract change)

Reuses the existing wire fields exactly as they are today (`targetSandboxId` +
`sandboxBackend`); only the *form shape* changes.
- Promote `<ComputeTargetControl>` to top-level; segmented Managed Sandbox / Connected
  Machine; demote the backend `<select>` into the sandbox kind's Advanced detail.
- Gate repo (gray on machine), env (hide on machine), per §3. Repo selection is *retained*
  but excluded from `resources[]` when `kind==="machine"` — this is the **UI half** of the
  clone-gating footgun (the runtime half — `repositoryUsesSandboxClone`,
  `runtime/src/index.ts:2068` — ships independently per `00-primitives.md §Concrete bug`).
- Make backend options descriptor-driven (`CAPABILITY_DESCRIPTORS`).
- Workdir for a machine defaults to `{ kind: "root" }` (the agent's launch dir) — **no
  `workingDir` field is sent yet**, so behavior is identical to today; the picker simply
  shows "Machine root" with custom-path/sub-folder controls *disabled* + a "coming soon"
  note. This keeps PR 1 free of any protocol change.
- Unify the two stores into `useSessionDraft` (internal refactor; no contract change).
- Fix the in-session/inspector inconsistency: shared `<ComputeTargetControl>` +
  inspector shows active machine.

Result: the worst confusion (buried compute, repos-offered-for-a-machine, two overlapping
compute controls) is gone with zero backend risk.

### PR 2+ — needs sign-off (the core refactor, `00-primitives.md` D1/D2/D4/D5)

Breaking / additive-contract changes, each gated on the corresponding primitive decision:
- **`workingDir` on `CreateSessionRequest` + `session_create` MCP + agent protocol** (D5):
  enables the real Project/path/sub-folder picker (replaces the `/workspace` virtual root for
  machines). *Additive field*; UI lights up the disabled controls from PR 1.
- **Project primitive + registry** (D4): a registered named path on a machine (UI to
  register + an agent tool). Until it lands, `<ProjectPathPicker>` offers only root + custom
  host-path; "named Project" is the additive third option.
- **Machine as primary compute, drop the mandatory home box** (D1) + **skip token
  distribution** (D2): lets the submit mapper send `sandboxBackend: undefined` for a machine
  with no home box provisioned, and removes the env-injection path entirely for machines
  (the UI already hides it in PR 1, so this is backend-only).
- The in-session live swap already exists (`SwapActiveSandboxRequest`, `contracts:3198`); no
  new surface needed — it just re-homes under the shared control.

### Open calls inherited from `00-primitives.md` (UI must follow the rulings)

- (b) Project creation = UI *and* agent tool, or start free-form `workingDir` + named
  Projects as sugar → determines whether PR 2 needs the registry or just the `workingDir`
  field. The `<ProjectPathPicker>` design above supports both (root/path now, named project
  additive).
- (c) Default NO platform-cloned repo onto a machine → encoded as the grayed repo + "uses
  its own checkout" copy (D3); confirm before allowing any machine-side clone toggle.

---

## Appendix — file:line index used

- `apps/web/src/routes/sessions-index.tsx` — `:39-45` backend literal; `:52` advancedOpen;
  `:53` local advanced state; `:79-87` submit; `:116` controls; `:151-199` strip;
  `:201-388` AdvancedSessionOptions; `:212-213` useMachines/selfhosted filter; `:250-263`
  Machine select; `:273-288` Environment; `:294-319` backend override; `:326-349` goal;
  `:352-383` MCP perms.
- `apps/web/src/lib/session-create.ts` — `:6-19` AdvancedSessionDraft; `:21-32` empty;
  `:37-39` targetSandboxIdFrom…; `:42-57` submissionExtrasFrom….
- `apps/web/src/context.tsx` — `:163,168,171,174,175,181` global selection; `:433-477`
  startSession; `:444-463` merge; `:460-462` targetSandboxId cast-through.
- `apps/web/src/components/repository-picker.tsx` — `:39` picker; `:203-215` GitHub-App gate;
  `:226-227` cross-installation block; `:263-275` per-repo branch input.
- `apps/web/src/lib/machine-selectability.ts:9` — `isMachineComputeSelectable`.
- `apps/web/src/lib/session-tools.ts` — `:54` buildResources; `:77,99` `mountPath = repos/<repo>`.
- `apps/web/src/routes/session.tsx:397-415` — in-session strip (Model+Tools only).
- `apps/web/src/components/session/sandbox-switcher.tsx` — `SessionSandboxSwitcher` "Run on:".
- `apps/web/src/components/session/inspector.tsx:72` — `InfoRow label="Sandbox"` (home backend).
- `packages/contracts/src/index.ts` — `:18-31` SandboxBackend(11); `:55-85` CapabilityDescriptor;
  `:101` CAPABILITY_DESCRIPTORS; `:123` modal workspaceRoot `/workspace`; `:371-401` selfhosted
  descriptor; `:398` selfhosted workspaceRoot `/`; `:3140-3148` MachineState; `:3150-3151`
  MachineKind; `:3161-3177` MachineView; `:3198-3201` SwapActiveSandboxRequest.
- `packages/runtime/src/index.ts` — `:1770` buildManifest root `/workspace`; `:2068`
  repositoryUsesSandboxClone (clone-gating footgun).
- `docs/design/connected-machines/00-primitives.md` — D1–D7, §Session binding, §Concrete bug, §Staging.
