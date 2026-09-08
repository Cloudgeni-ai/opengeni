# Unified Skill content and writes

`packages/core/src/domain/skills.ts` exports `listSkills`, `readSkill`,
`saveSkill`, `installSkill`, `approveSkill`, and `restoreSkill`.
`packages/contracts/src/skills.ts` owns their shared inputs and receipts.
`packages/db/src/skills.ts` is the driver-neutral persistence adapter;
`skill_apply_lifecycle(uuid, uuid, jsonb, jsonb)` is the atomic database boundary.

A Skill has exactly one scoped identity and current head in
`preference_registry_preferences`, and one immutable revision history in
`preference_registry_revisions`. A revision's `skill_files` is its complete
UTF-8 text folder, including nonempty `SKILL.md`. Limits are 128 files,
256 KiB per file, and 1 MiB total. Paths are root-relative, unique, and cannot
contain traversal, backslashes, absolute paths, control characters, or drive
prefixes. NUL, malformed Unicode, and binary storage are unsupported.

Historical single-text revisions retain NULL `skill_files` and project their
exact `content` as `SKILL.md`. Historical content hashes and snapshots are not
rewritten. The existing content hash remains the hash of `SKILL.md`, not the
folder; `skillBundleHash` separately identifies the full canonical text folder.
Activation mode is frozen with the revision. Session-selected portable Skills
remain excluded from ambient registry snapshots, including after customization;
explicit selection can still materialize their current folder.

Portable source identity is `(workspace_id, plugin_id, facet_key)`, bound to
the registry identity by `skill_source_bindings`. No matching by name or
content takes place. Portable plugins, immutable versions/facets/files,
installations, and owners continue to describe distribution and upstream
ownership, but no longer choose a second mutable content head. Source updates
may advance an uncustomized source revision; they preserve a human- or
agent-customized active revision. Existing portable reads resolve the current
registry folder. An inactive proposal is never returned as an installed active
Skill. Legacy single-text saves of source-bound Skills fail closed rather than
silently dropping supporting files.

## Authority and receipts

HTTP callers must authenticate and authorize workspace/scope management before
constructing a human actor. `principalKind: human_session` is a trusted boundary
fact, not a model argument. Humans bypass Learning, not authorization. Existing
organization and personal preference scope visibility remains intact.

Authenticated service/API-key callers install sources as a distinct `service`
actor, never as a human. This authority is limited to workspace installation:
Learning Off refuses it, Suggest retains a pending revision, and Automatic makes
the revision live. Machine callers cannot approve revisions, write authored
folders, restore history, or remove a final Skill source through this actor.
Those operations are not silently attributed to an initiating human.

Agent claims must come from the live host attempt, never the tool arguments.
The database binds account, workspace, session, active turn, active attempt,
execution generation, state, and interruptions. Agent writes are workspace-only
and attributed to `service:skill-attempt:<attempt id>`; no human impersonation,
Knowledge evidence, or confidence score is involved. All workspace agents share
the same Skill management authority; there is no per-agent or per-Skill ACL.

Learning reads the current workspace policy under a shared lock: Off refuses
durable writes, Suggest saves an inactive revision, and Automatic activates a
valid revision directly. No active policy defaults to Suggest, matching the
workspace Learning default. Human approval activates an exact revision with head
CAS. Restore saves the selected historical folder as a new immutable revision
and follows the same actor/Learning rules.

Every accepted write returns an immutable operation receipt containing
`operationId`, `skillId`, `revisionId`, `outcome` (`applied`, `pending`, or
`preserved`), and `replayed`. Identical operation-key retries return the same
receipt; changed input with the same key fails. Saves, approvals, and restores
require both `expectedRevisionId` and `expectedScopeVersion`; stale requests
fail rather than overwriting intervening work. A retry still requires a valid
actor; a stale attempt cannot use replay to regain access.

`installPortableSkill` requires a truthful `skillActor` and optionally accepts
`skillOperationId`; it commits distribution and the registry transition in the
same transaction. Callers omitting actor context fail before any write. Its
return includes `skillReceipt`, so pending installation must not be reported as
activated. `installSkill` alone requires an already-installed portable facet.
Portable install retries acquire the existing Skill operation lock and replay
before distribution writes or installation-version CAS. The same immutable
Skill receipt retains a private original-request hash and original installation
result (including the original `created` value); this is a historical operation
result, not a fresh claim about current installation state. Public lifecycle
receipts do not expose this envelope. Replay rechecks
the actual actor and exact live agent attempt through the existing lifecycle.
`replayPortableSkillInstall` (DB and core export) can run before remote source
resolution. Its `requestIdentity` must match the install's `skillRequestIdentity`:
host-canonical original source/URL, options, owner and explicit installation CAS,
not a freshly resolved commit or folder. Adapters must construct this identity,
not accept a caller-provided hash. Without an explicit identity, install binds
the full resolved input; callers cannot safely replay a moving URL before
resolution. Receipts predating the envelope fail closed, not reconstruct a
possibly changed installation. A missing operation ID means a new operation.
Last-owner direct, Pack, and plugin removal resolves the canonical head atomically
with distribution cleanup through `skill-source-release.ts`. Source-managed
workspace heads deactivate through the existing human registry lifecycle;
customized or re-scoped heads remain active and return an explicit preservation
warning. Immutable source bindings and history survive uninstall. Physical owners,
including pending Pack owners, prevent cleanup even when not runtime-effective.
The removal and upgrade-finalization APIs accept `skillActor`; removing a bound
Skill requires a trusted `human_session` actor. Missing, service/API-key, and agent
authority fails closed and rolls back. A subject ID is never treated as proof of
human authority. No new agent deactivation authority is introduced here.
Removal results expose `skillReleases` with the Skill/revision IDs, disposition,
event ID, and warning. Pack and plugin finalizers return these receipts too;
plugin operation replay retains them. Pack adapters must retain returned receipts
when finalizing their operation result.

## Release

After cutover every new revision must have files, including legacy human CREATE;
activation of historical null-files revisions fails closed. History reads remain
available. Save, install, restore and approval derive metadata with the one
`@opengeni/contracts` parser. Valid YAML bytes and decoded metadata are preserved;
SQL enforces structure, hashes, actor/tenant authority and atomicity, not a second
interpretation of YAML. Restore requires valid frontmatter; plain archived content
must be explicitly repaired through save. Files-bearing activation remains
compatible with human governance.

The exact 0423 runner stage executes inside an explicit migration transaction:
setup and owner window, TypeScript parsing into a temporary staging table, then
SQL backfill/guards and the migration ledger receipt. Raw SQL without that stage
fails closed. All existing active authored heads receive new canonical revisions;
original revisions, hashes, scope and provenance remain in history. Already valid
frontmatter wins over stale DB metadata and keeps its exact bytes. Plain text gets
a deterministic header from legacy metadata without changing its body. Legacy
names use a safe lowercase slug, or `legacy-<stable UUID>` if no legal name can be
derived without truncation. Invalid/ambiguous headers and oversized descriptions
abort the entire cutover for explicit repair. No malformed record is silently
dropped, and no additional summary field is created.

The installed-source backfill opens an owner-only `NO FORCE` window on the four
portable source tables and the registry heads, revisions, events, and source
bindings. RLS stays enabled for application roles. Deferred proposal-event and
foreign-key constraints are flushed before restoring FORCE RLS, all within the
migration transaction. A seeded `NOSUPERUSER NOBYPASSRLS` owner test verifies
cross-tenant identity preservation, folder content, and the restored posture.

Migration `0423_unified_skill_lifecycle.sql` is a maintenance cutover. Drain all
old API/control/turn workers, supply the exact application database role list,
migrate, provision roles, and start only the unified-Skill-aware release. Never
restart a pre-0423 binary: its installed reads bypass the registry content head.
The migration preserves existing source ownership, backfills installed Skills
by portable identity, and rejects invalid existing folders for repair rather
than silently truncating them. New binding/write-receipt tables are FORCE-RLS and
read-only for the runtime role; mutation requires the exact SECURITY DEFINER
lifecycle capability.

### Stored execution configuration maintenance

The same atomic 0423 runner calls `packages/db/src/skill-config-migration.ts`
after staging registry metadata. It converts headerless Skills in current
`sessions.skills` and `workspace_packs.manifest` (including inline automation
template Skills). It uses historical name/description, preserves the complete
body and supporting UTF-8 file bytes, and applies the shared parser and folder
limits. Valid YAML, its cached descriptor fields, unrelated manifest fields,
and source timestamps remain unchanged; the stored read projections derive
canonical metadata without rewriting those bytes. Names that cannot be slugged
use a stable source/array-position hash, never content-based identity or merging.
Canonical name collisions, malformed/apparent YAML headers, missing historical
metadata and overflow are repair-required, not silently normalized or dropped.

Before replacing any current configuration, the migration inserts its original
JSON, PostgreSQL JSONB-text SHA-256, replacement hash, tenant/source identity,
conversion version and truthful migration actor into
`skill_config_conversion_receipts` in the same transaction. These receipts survive
source replacement, but cascade with deletion of their owning workspace, using
the existing document-migration receipt retention pattern. Direct updates and
deletes remain forbidden. This is immutable maintenance evidence, not another
Skill head. The table has FORCE RLS and **no
runtime table privileges**, including SELECT: an archived private Session's
configuration must not become workspace-readable audit content. Authorized
database maintenance uses explicit account/workspace context to inspect it.
Workspace tenancy advisory locks, table locks and old-value CAS protect writes;
the conversion entry also verifies that it is running as the table owner inside
the parser-backed migration's temporary owner window. It cannot be reused as an
ordinary runtime session-configuration writer.
The migration ledger makes committed retries no-ops. A failure rolls back all
configuration changes, receipts, registry conversion and schema changes.

Pack installation `manifestSnapshot` is returned as exact saved JSON alongside
its unchanged digest, not parsed through current admission rules. This keeps
disabled historical snapshots readable and does not turn them into executable
configuration. Execution explicitly uses `StoredCapabilityPack`, deriving labels
from valid frontmatter and rejecting headerless or malformed Skills.

The owner-only RLS window also covers current configurations and the exact
Session/automation/Pack tables read by preflight; FORCE is restored before commit.
Preflight reports source kinds/IDs and blocker counts without content. It refuses
conversion when plain inline Session Skills have a nonterminal accepted turn or
an active-turn pointer. It also refuses plain or invalid Skills in non-disabled
Pack installation snapshots, active/paused current automation revisions, queued
or dispatching accepted runs, and accepted event matches not yet assigned a run.
Already assigned events do not independently block after their run is terminal.

Operator repair requirements:

- Before stopping old runtimes, complete or explicitly cancel affected accepted
  work. Stopping database clients alone does not retire accepted execution pins.
- Replace active plain automation templates with a newly validated revision, or
  explicitly disable the trigger. Pausing alone is not archival. Preserve every
  old revision and accepted execution payload.
- Explicitly disable or replace active plain Pack sources through an appropriate
  audited lifecycle. Migration never rewrites `pack_installations.manifest_snapshot`
  or its digest, published plugin versions/facets/files, or accepted event matches.
  Ordinary Pack re-admission overwrites the current installation snapshot: archive
  that original separately before using re-admission as an operator repair.
- Repair malformed mutable source configuration explicitly, then retry the whole
  migration. The failure inventory reports up to 30 IDs and the total blocker
  count; repeat preflight after repairs if further IDs remain.

Disabled Pack snapshots, noncurrent/disabled automation revisions, terminal runs
and immutable audit history remain unchanged. Re-enabling a plain historical
artifact still requires explicit valid replacement; no read-time synthesis or
silent rebinding is supported. Deployment/host configuration outside these DB
sources needs its own validation. This maintenance inventory materializes source
JSON in memory and has not been load-tested on a large production dataset.