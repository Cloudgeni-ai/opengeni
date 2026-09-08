# One Skill system

Design dossier · updated September 8, 2026 · tracking: OPE-421.

Design-review baseline: `origin/main` at `d33ce73b54fb4656213790dc4b035e9bcafc9a41`.
Implementation started from `cb97a3eb` on branch `feat/unified-skills`.
This is a proposed implementation design, not a claim that the system is built.
It replaces the previous draft and appended audit. Statements marked proposed
are recommendations, not additional user agreements.

## Summary

One Skill product for installed and authored Skills, including what the UI now
calls preference-registry Skills. Read without a sandbox. Edit small text files
directly; use a sandbox when execution or complex editing needs one. Keep saved
history and protect local customizations from upstream replacement.

Only `skill_read` is eager. Management tools are lazy and explained by a small
built-in Skill. Keep the agent interface simple; do not make agents manage
read-version pins or introduce remote preview as a prerequisite.

## 1. Agreed direction

- A Skill is a **folder containing `SKILL.md` and supporting files**, including
  nested paths. `SKILL.md` is the entry point, not the whole Skill.
- Unify portable Skills and preference-registry Skills. Two editing interfaces
  are fine; two independently writable versions of the same Skill are not.
- Instructions remain always-on rules; Memory holds facts and outcomes;
  Documents are evidence. Plugins and Packs compose/distribute capabilities,
  including Skills. None becomes another Skill store.
- Provide a first-class Skills destination under Capabilities. Agent Knowledge
  may show authored/managed Skills from that same system.
- Agents may search the public ecosystem, install, create, and edit Skills,
  including installed Skills. Workspace autonomy controls persistent changes;
  do not infer permission from an agent saying “the user asked.”
- Prioritize Autonomous behavior; a substantial review UI is secondary.
- Simple editing must not require a sandbox. Checkout is available when needed.
- Normal reading must not require starting or materializing into a sandbox.
- `skill_read` is eager: omitted paths read `SKILL.md`; explicit paths read
  exactly those files. Never implicitly add `SKILL.md` to explicit paths.
- All Skill management tools are lazy. A built-in management Skill explains
  discovery, creation, editing, and the system's behavior.
- Preserve versions so earlier content can be restored. Upstream updates must
  not silently overwrite workspace customizations.
- Do not require remote pre-install inspection or session-level read-version
  pinning for this work.

## 2. Proposed simple model

A Skill has a stable identity, display metadata, a current saved folder, and
saved history. Installed Skills also retain their source and upstream version.
The exact schema is still to be chosen; a Skill is not identified solely by its
frontmatter name, since different sources may use the same name.

Direct file saves and sandbox publishes create revisions of the **same** Skill.
Names remain convenient labels. The backend handles identity, atomic writes,
history, and protection against stale edits; these are not separate user flows.

Read the current saved version on each call. A single multi-file read should
return a coherent folder, but separate reads may observe subsequent saves.
There is no session-wide revision-pinning protocol in this design.

### Text files, not arbitrary binary assets

Proposed boundary: `SKILL.md` plus supporting UTF-8 text files, regardless of
extension. Code, shell scripts, JSON, YAML, configuration, reference text, and
text templates are included; extensionless files are allowed.

Do not add a programming-language extension whitelist or binary/blob support
for this iteration. Validate paths, encoding and size. Reject unsupported
files with clear paths rather than silently dropping them. UTF-8 validity is
not a safety assessment or proof that a file is useful guidance. Decide the
precise NUL/control-byte policy before shipping; encoding checks alone do not
perfectly classify text.

This deliberately limits what OpenGeni can import. It is not a claim that every
external Skill must be text-only. Keep the existing limits initially unless
compatibility testing gives a reason to change them.

### Local edits and upstream updates

Keep the upstream reference separate from the current workspace content.
Proposed behavior: an unmodified Skill can receive an authorized source update;
a customized Skill retains its content and reports that an update is available.
No automatic merge or new fork-management UI is required.

Pack refreshes must obey the same protection. An update to a Skill must not
accidentally repoint unrelated plugin facets or disrupt another owner's
installation. Preserve existing ownership rather than treating a Pack as only
a disposable source label.

## 3. Agent tools

Names below are proposed API names. Only the reader's eager visibility and path
semantics are settled; final schemas should follow the shared tool conventions.

| Tool | Visibility | Purpose |
| --- | --- | --- |
| `skill_read` | Eager | Return requested text files without a sandbox |
| `skill_search` | Lazy | Discover installed and available Skills |
| `skill_install` | Lazy | Resolve and install a source into the workspace |
| `skill_save` | Lazy | Create a Skill or save specified text-file changes |
| `skill_checkout` | Lazy | Materialize a Skill when files on disk are needed |
| `skill_publish` | Lazy | Save an edited sandbox folder through the same write service |

Management tools use the canonical tool gateway and normal authorization.
“Eager reader built into the worker” describes availability to the model, not
permission to build a separate worker-only backend. Checkout is the only
operation here that inherently needs a sandbox; publishing a sandbox folder
naturally depends on that folder being accessible.

### Read

```text
skill_read({ skill, paths? })
```

- Omit `paths`: return `SKILL.md`.
- Specify `paths`: return exactly those paths, including multiple paths.
- Proposed: reject an empty array rather than ambiguously defaulting it.
- Proposed: return files with their paths; report missing paths explicitly.
  Never silently omit files or present truncation as complete content.
- Resolve ambiguous names explicitly rather than choosing a source silently.
- Include a bounded way to discover available paths on demand; do not put
  every file path into every standing prompt.

### Search and install

Start with search → install → read. Remote preview is not a requirement.
Support the curated library and public ecosystem discovery, not merely a URL
input mislabeled as search. Exact provider integration needs verification.

The backend resolves and pins imported bytes. Agents should not have to invent
a content hash that no prior tool returned. Either return an opaque resolved
source from search or resolve within install. Preserve the existing human
preview/install checks; do not weaken that API to simplify the agent interface.

Installing guidance does not grant tools, credentials, or additional access.
External Skill content cannot change platform permissions or Learning policy.

### Save and publish

Proposed: `skill_save` accepts specified text files and explicit deletions.
Omitted files remain unchanged. Creating a Skill requires `SKILL.md`; deleting
that required file without replacing it is invalid. Updating a small reference
file should be as easy as updating the main file.

Publish transfers an edited directory through a backend/sandbox file path, not
by making the model serialize an entire directory into a tool argument.
Save and publish share validation, authorization, history, and activation.
Both detect stale writes and make retries safe. Exact schemas remain open.

## 4. Learning and permissions: agreed simplification

Do not distinguish agent-initiated from allegedly user-requested tool writes.
Authenticated human editing has human authority; agent calls remain agent calls.
All agents in a workspace can discover and read shared workspace Skills and
use management tools. No per-agent or per-Skill permission configuration is
introduced for ordinary shared workspace Skills. Workspace boundaries and
platform-owned built-in protection remain enforced by the backend.

Agreed target behavior:

| Learning mode | Persistent agent change |
| --- | --- |
| Off | Refused; no durable Skill change |
| Require approval | Inactive proposed change until approval |
| Autonomous | Valid, authorized change becomes current without approval |

Human saves bypass the agent Learning decision, not access checks or validation.
Prior versions remain available for restoration; restoration is a new recorded
change, not deletion of history. It must not silently erase a later edit.

Reuse the existing mode setting and useful approval/history mechanisms. Do not
assume that every file edit should traverse Knowledge claims, evidence reviews,
confidence scoring, and the entire existing derived-learning evaluator.

Ordinary Skill edits do not require Knowledge claims, evidence reviews or
confidence evaluation. Implement the mode decision directly in the shared Skill
write lifecycle, retaining tenancy, live-attempt checks, history and safe writes.
Existing source-policy compatibility must be accounted for during migration,
not silently discarded. A complex review inbox can wait; correct Require-approval
backend behavior cannot be silently replaced with Autonomous or Off.

## 5. Prompt and built-in management Skill

Keep a short catalog of available Skill names/identities and descriptions.
Do not make all file paths standing prompt content or inherit an old descriptor
budget without checking the combined catalog. Search handles overflow.

Minimal core instruction, proposed:

> Read relevant Skills with `skill_read`. Omit paths to read `SKILL.md`, or pass
> paths to read exactly those files. Reading does not require a sandbox. To find,
> install, create, or edit Skills, read the built-in `opengeni-skills` Skill.

The built-in Skill explains the lazy management tools, text-only file rules,
Learning behavior, direct edits versus checkout, history, and source updates.
It must itself be readable without a sandbox or management-tool discovery.
Keep this explanation in one place rather than repeating full workflows across
core instructions, preference guidance, and filesystem loader instructions.

Native tool-bound, repository, and session-selected Skills already exist. Their
readability does not imply editability. Preserve these sources during rollout;
prefer one reader where bytes are available without a sandbox, but do not promise
remote reads of repository files that only exist on a machine. Define any
temporary filesystem-loader exception explicitly before retiring `load_skill`.

### Bundled guidance and embedded products: open integration detail

The September 8 implementation review identified inconsistent bundled selection:
artifact guidance follows the tool catalog, Sites is selected by compute backend,
and Connected Machines omit video guidance because the old loader cannot deliver
the files. These are existing delivery constraints, not a product rule that
Connected Machines should receive different instructions.

The new server-readable native artifact loader has no compute-backend input and
does not stage files. Live selection remains to be wired. Preserve generated
Sites package-version metadata when reading or checking out its folder.

Proposed, not yet approved: make bundled guidance follow enabled capabilities
by default, with an optional embedding-product allowlist to restrict that set
(omitted = defaults; empty = no bundled guidance). Resolve selection once for
prompt descriptors, search and read; hiding a descriptor alone is insufficient.
This also needs to cover the built-in management Skill, which the current
foundation adds unconditionally. Do not confuse this platform-bundle selection
with per-agent permissions for ordinary shared workspace Skills. The exact
public configuration placement and how host restrictions propagate to child
sessions remain open; do not ship a runtime-only flag as an embedding contract.

## 6. Current implementation: verified baseline

Paths below refer to the main commit recorded at the top, not necessarily this
document branch's checkout. These are source findings, not production tests.

| Area | Current behavior / code |
| --- | --- |
| Portable storage | `packages/db/src/schema.ts`: `capability_skill_facets` and `capability_skill_files`; relative paths and text in Postgres |
| Installation | `packages/db/src/index.ts`: `installPortableSkill`; immutable plugin versions, installations and ownership |
| Import | `packages/core/src/domain/skill-imports.ts`: `resolveSkillImport` resolves supplied URLs; this is not ecosystem search |
| File limits | `packages/runtime/src/skill-library.ts`: 128 files, 256 KiB per file, 1 MiB total; imports strictly decode UTF-8 |
| Human install | `apps/api/src/routes/skills.ts`: existing preview/install boundary |
| Runtime | `packages/runtime/src/runtime-skills.ts`, `index.ts`: composed Skill sources and SDK lazy loading, not proof of eager sandbox copying |
| Tool delivery | `packages/tool-gateway`, `packages/runtime/src/lazy-tool-transport.ts`: shared gateway and eager/lazy model surfaces |
| Preference Skills | `docs/preference-registry.md`, `packages/runtime/src/workspace-governance.ts`: descriptors and exact registry retrieval handles, separate lifecycle |
| Learning | `docs/workspace-learning-policy.md`: no-active-policy default is now `suggest` / Require approval; activated policies and accepted snapshots remain authoritative |
| Existing review UI | `apps/web/src/routes/preference-registry-admin.tsx`: pending Skills under “Finish saving”; not a complete multi-file review interface |

Current instruction locations to reconcile:

- `packages/runtime/src/operational-instructions.ts`: `# Using skills`.
- `packages/runtime/src/workspace-governance.ts`: registry handle retrieval and
  `remember lane=preference` routing.
- `packages/runtime/src/workspace-skills.ts`: repository discovery/instructions.
- `packages/runtime/src/index.ts` and SDK lazy loader: filesystem loading.

The tool gateway introduced around PR #2166 is now present in main. This work
should use it, not add a competing execution path. Skills-over-MCP remains a
possible later source/transport; its changing draft status is not an internal
implementation dependency and has not been revalidated for this rewrite.

## 7. Implementation sequence and checks

Existing tracking: OPE-421; OPE-424 read, OPE-425 search/install, OPE-428 writes,
OPE-426 checkout, OPE-427 UI. Those issue descriptions need reconciliation with
this dossier; this document does not assert they have been updated.

1. **Set the shared content/write boundary.** Resolve identity, migration and
   ownership, and the simplified Skill Learning path. Choose one write authority
   and define how legacy registry callers reach it. Do not lose scopes, active
   state, history, or source ownership while converting text entries to folders.
2. **Read without a sandbox.** Add the eager reader, short catalog and readable
   built-in management Skill. Adapt current sources without breaking native,
   repository or session Skills. Verify omitted/explicit paths, missing files,
   bounded output, and a no-sandbox session. Separately measure whether ordinary
   worker startup still provisions a sandbox; lazy file loading is not proof
   that startup is avoided.
3. **Direct saving and migration.** Add lazy file saves through the shared write
   lifecycle, preserve omitted files, record history and handle stale writes.
   Move registry writes and UI editing to that same authority, or use a bounded
   compatibility adapter. Verify all three Learning modes, human access checks,
   cross-workspace denial, retries, restore, and legacy read/write convergence.
4. **Search and install.** Integrate a real discovery provider, pin source bytes
   server-side and install through the same governance. Verify discovery versus
   URL resolution, unsupported-file errors, source failures, duplicate names,
   mode behavior, and protection of customized/Pack-owned Skills.
5. **Checkout and publish.** Materialize only on demand; publish directories
   through the same revision service. Verify round trips, explicit deletions,
   safe paths, no symlink escape, unchanged-file preservation and stale edits.
6. **Unified UI and cutover.** Capabilities and Agent Knowledge project the same
   catalog. Provide simple editing and history; retain approval behavior without
   requiring a new elaborate inbox. Remove obsolete prompts/tools only after
   compatibility tests pass. Test migration and deployment with old callers,
   document supported recovery, and reconcile the architecture documentation.

Implementation is authorized by the subsequent user confirmation. UI convergence
may land alongside writes; do not leave a second live editor until the end.

## 8. Remaining decisions, not hidden assumptions

Before implementation:

- Exact shared identity/schema and registry migration, preserving current scope
  and ownership semantics without adding new personal/org agent-write scope.
- Map the agreed simple Learning behavior onto a safe shared write lifecycle.
- Exact text validation, import failure policy, and bounded read/path discovery.
- Final file-save/publish inputs and concurrency/retry conventions.
- Concrete search provider and source resolution without a mandatory preview.
- Compatibility behavior for native, repo, session and Pack sources.

Deferred rather than blocking this iteration: remote pre-install reading,
Skills-over-MCP transport, automatic upstream merging, sophisticated review UI,
new personal/org agent-write scope, and dedicated agent uninstall tooling.
No binary-file support or session-level read-version pinning is planned here.

## 9. Completion criteria

This design is implemented only when agents can read without a sandbox, discover
lazy management tools through the built-in Skill, install and edit text Skills
under the configured Learning mode, and use direct editing or checkout against
one shared content/history system. Both UI destinations must agree; migrations
must preserve existing behavior and customized Skills must survive source updates.
Passing a single no-sandbox read test is not completion of the full system.