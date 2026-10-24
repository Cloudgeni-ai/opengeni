# Prepared administration bundle — inactive

This bundle is **inactive by default**. `bundle.ts` is offline: it reads saved
JSON and creates payloads/readback assertions only. `stage.sh` has read-only
observation/reconciliation actions and separately named write actions requiring
an explicit flag. Those write actions are for an authorized repository
administrator **after a separate rollout go**. Publishing this documentation,
creating an App, or permitting candidate-only
CI shadow does not authorize main control. Main control and the tested-descendant
ops release-lane change remain held through the second production release until
their rollout owner explicitly releases those holds.

Do not switch the existing anonymous, guarded, one-shot read-only job to active.
The continuous service, secret injection, qualified image and stop/restart
qualification are separately owned deployment work. No live admin writes or
controller activation are part of this change.

## Intended boundaries

| Ruleset | Refs | Bypass | Rules |
| --- | --- | --- | --- |
| Existing `Protection`, updated in place | Existing default-branch condition (`main` required) | Dedicated App and `OrganizationAdmin`, `always` | Existing PR admission parameters, including squash-only manual merges, unchanged |
| `Opengeni batcher immutable refs` | `main`, `queue/live/**`, `batcher-state` | **None**, including administrators and the App | Non-fast-forward and deletion prohibited |
| `Merges go through the batcher: add the queue-ready label` | `main`, `queue/live/**`, `batcher-state` | Dedicated App and `OrganizationAdmin`, `always` | App is the normal writer; organization administrators have emergency bypass |

On **main**, the App bypasses PR admission and the dedicated-writer restriction,
never the separate immutable guard. The writer restriction is the exclusive
normal-path gate; PR admission alone would still permit manual merges. Namespace
creation/update bypass authorizes candidate/state writes; it does not bypass the separate immutable
guard. Lease commits descend from the previous state commit, so their CAS pushes
remain fast-forward despite the state-specific `--force-with-lease` wire option.
Main receives no force authorization. Candidate refs remain create-only in the
controller; the ruleset itself permits App FF updates and is not a substitute
for that implementation invariant.

Organization administrators have `OrganizationAdmin`/`always` bypass on admission
and writer restrictions only. This is not `RepositoryRole` (repository admin).
GitHub's REST schema ignores `actor_id` for `OrganizationAdmin`; the payload uses
the constant 1, not an assigned organization or installation ID. `always` permits
direct updates as well as PR merges, including the listed queue/state namespaces.
GitHub does not constrain this grant to emergencies: emergency-only use is operator
policy. These actor and mode semantics are defined by the
[GitHub rulesets REST API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).
No live API write is claimed by the offline tests; unexpected provider payload
normalization must hold and reconcile, not relax comparison. The separate immutable guard still has no bypass. An authorized
administrator can run the emergency OFF policy restoration; policy
administration cannot itself be prevented by a repository ruleset and is not
permission for routine bypass. The original normal squash path returns only after
OFF restores it. No linear-history enforcement is added (candidate commits have two
parents). This does not enable auto-merge. Production/tag rules, full-main CI and
release proof are unchanged. Diagnostic `queue/shadow-traffic/**` and shadow state
refs are deliberately outside these live namespaces. A credential with repository
contents write is not intrinsically branch-scoped: unchanged production/tag
protections and application behavior still matter. This is not an assertion of
universal branch confinement or inability of a repository administrator to edit
the rules later.

The no-bypass deletion guard also prevents candidate/state ref pruning. Future
compaction requires a separately reviewed guard change and retained audit evidence;
neither a controller cleanup job nor this rollback may silently delete those refs.

## Dedicated App registration and installation (manual, not performed here)

Use [app-manifest.json](app-manifest.json) as the exact registration specification.
In the **Cloudgeni-ai organization → Settings → Developer settings → GitHub Apps**,
register a private App with that name/homepage and only these repository grants:

- Contents **write**: fetch and atomic candidate/state/main Git transactions.
- Workflows **write**: commits can contain workflow-file changes.
- Actions **write**: read bound receipts and rerun the whole workflow once.
- Pull requests **write**: exact-head reconciliation and remaining-delta follow-up PRs.
- Issues **write**: landing, parking and reconciliation comments (not admission attestations).
- Metadata **read** is GitHub's implicit grant. No Administration permission,
  organization/account grants, deployment grants or subscribed events.

Disable the webhook's **Active** setting. No webhook URL, OAuth callback, setup
callback or user authorization flow is needed: this controller polls. The JSON is
a valid manifest specification, not a hosted manifest-registration flow; this
bundle does not provide a redirect/code-conversion service. If its fixed App name
is unavailable, resolve ownership before registration rather than installing an
unknown similarly named App. Install it on **Only select repositories → opengeni**,
not all organization repositories. A permitted organization owner performs these
steps and records the **assigned App ID and installation ID**. The ruleset's
Integration `actor_id` is the **App ID**, never the installation ID or bot user ID.

The owner generates/saves the private key through the approved secret store and
the deployment owner injects it by reference. Never put it, installation tokens
or the existing inspection credential in this directory. Do not rotate the
workspace's immutable GitHub token. Runtime uses `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`; leave `GH_TOKEN` and
`GITHUB_TOKEN` unset in the controller, since they take precedence over App auth.
No token is minted by this bundle.

Before planning, an administrator/deployment owner supplies and exports the assigned
numeric `APP_ID` and `INSTALLATION_ID`, an App JWT in `APP_JWT`, and a short-lived
scoped installation token in `INSTALLATION_TOKEN` through the secret mechanism
(do not echo them). The checked-in [read.sh](read.sh) makes both JWT identity GETs
with an explicit `Authorization: Bearer` header via curl's `--header @file`, never
the default `GH_TOKEN` `token` scheme. The temporary header file is mode 0600 and
removed on success or failure; the JWT is not placed in process argv, and debug
tracing is disabled. Use curl with header-file support (7.55 or newer).
Installation-token minting, if performed separately by its owner,
also requires Bearer for its App JWT. This bundle does not mint it.

Create a new private task directory **once**, record its exact path in the
operator's retained handoff, then run the identity check:

```sh
ADMIN_DIR=$(umask 077; mktemp -d /workspace/tasks/batcher-admin.XXXXXX)
export ADMIN_DIR
PLAN="$ADMIN_DIR/plan"
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" identity
```

Stop if any assertion fails. These checks establish identity/configuration, not a
successful active Git transaction. The App must not be placed into another
bypass group. Human admin credentials for later ruleset changes need repository
Administration write and organization authority to install the App; the runtime
App deliberately has no Administration write. The repository must support active
rulesets for this plan; inherited restrictions cannot be bypassed by changing a
repository rule.

Successful identity checks retain raw readbacks and an `identity-receipt.json`
binding the actual App ID, installation ID, repository and permissions. Forward
write stages require that receipt to match `plan.json`. Reverse restoration
requires admin authority but not a still-working runtime App, so revoking an App
does not strand rollback. Re-run identity after relevant identity/permission changes;
a retained receipt is evidence of its observation, not continuous authorization.

## Capture exact prior configuration and generate offline payloads

Use an administrator's authorized `gh` context for complete bypass readbacks, not
the runtime App token. Keep snapshots/receipts private and retained outside Git.
Run from the reviewed repository checkout; require `bun`, `gh`, `curl`, `jq` and Bash.
The checked-in helper makes only repository/organization GET requests and a
read-only GraphQL query. Each invocation retains a fresh raw inventory and every
detail. Missing/inaccessible classic or inherited protection data fails; it is
not interpreted as absence.

```bash
(
  set -euo pipefail
  BEFORE=$(bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" snapshot)
  bun docs/merge-batcher-admin/bundle.ts prepare "$BEFORE" "$APP_ID" "$INSTALLATION_ID" "$PLAN"
  sha256sum "$PLAN"/*.json
)
```

After any shell/process failure, **re-enter the existing directory**, never create
a new plan to bypass a write intent. Load the reviewed files again; do not re-run
`prepare`. Replace the path below with the exact retained path (not a new guessed
directory). Inject secrets again through the secret mechanism if needed:

```sh
export ADMIN_DIR=/workspace/tasks/batcher-admin.RETAINED_PATH
PLAN="$ADMIN_DIR/plan"
# Each call is its own fail-stop process; it cannot terminate the login shell.
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check original
```

Select the appropriate check/reconciliation stage below if effects already
occurred. `read.sh` may also be sourced for read-only helper definitions; sourcing
it has no side effects or shell-option changes. `stage.sh` sources it itself.

`prepare` refuses an existing output directory. It locates the unique
repository-owned `Protection` by its readback identity; no hardcoded live ruleset
IDs are shipped. It requires the observed active default-branch squash admission
shape and no classic protections. Unknown/missing rules or bypass fields fail
rather than silently lowering protection. Inspect **all** inherited/overlapping
rules and current ref permissions before go; matching JSON cannot prove a new
identity is accepted by GitHub. Future policy drift needs a new reviewed plan,
not a relaxed assertion. No production/tag change is proposed.

`plan.json` retains the complete before snapshot, App/installation IDs and payloads.
This emergency-admin revision uses **schemaVersion 3**. Versions 1 and 2 are not
silently upgraded or accepted for activation.
Generate a fresh, independently reviewed version 3 plan from untouched live
originals. Retain older evidence rather than overwriting it. Every verification
reconstructs the proposed payloads from the original snapshot and assigned IDs;
edited parallel files or edited plan payloads cannot change the reviewed bypass set.
For comparison only, an exact update rule with parameters absent is equivalent
to the exact explicit `update_allows_fetch_and_merge:false` form. GitHub can omit
this default in stored readbacks. This applies to both sides, including unchanged
original inventories; saved originals and request payloads are not rewritten.
True, empty/null parameters, nonboolean values, extra keys and duplicate/extra
rules remain mismatches. A failed prior drill's receipts/intents stay quarantined;
this compatibility rule does not authorize fabricating a receipt or reusing them.
`restore.json` retains the original writable fields, including original bypass
actors and every PR parameter. API-generated timestamps/links are retained in
the raw snapshot but are not valid PUT fields. `guard.json`, `namespace.json`,
`admission.json` are concrete API JSON, not templates needing guessed actor IDs.

**Unproven provider round-trip:** the current GET includes the undocumented PR
parameter `require_extra_approval_for_unattributed_changes`. It is deliberately
preserved in admission and restore payloads, not dropped to satisfy a narrower
OpenAPI schema. No no-op PUT is executed by this task. If forward or restore PUT
returns **422**, leave all writers stopped, retain the exact payload/response and
read back the current stage. In particular, a rejected restore may leave
`applied` in place: its no-bypass guard and exclusive writer restriction remain;
manual merges stay **held**, not falsely advertised as available.
Do not remove protective rules, omit the field or weaken policy to make recovery
pass. Provider/admin resolution and a newly reviewed round-trip plan are required;
exact-prior restoration is prepared but not proven accepted by GitHub. If a
provider-side issue is resolved without changing the payload, the explicit
reverse-only reissue below may repeat that identical request. It never removes
the undocumented field; changing policy still requires separate review.

## Prepared API changes — administrator runs only after explicit go

Coordinate an exclusive admin change window, obtain the current Version-window
clearance, and stop all live controllers first. Before activating a writer, perform
the authorized **live apply → OFF → exact restoration drill** using the real App
and this exact plan. Static tests do not establish provider round-trip acceptance.
The rollout owner must retain both drill receipts and reauthorize a fresh reviewed
apply plan; never erase old write intents to reuse it.
No transaction spans these REST calls; full inventory assertions detect drift but
cannot eliminate a last-moment concurrent administrator edit. Abort/reconcile if
that happens. Reconfirm identity/install permission receipts and the original
snapshot immediately before the first mutation. Guard first; admission last:

```sh
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" create-guard --apply-after-go
# Check success and readback before issuing the next stage.
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" create-namespace --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" admit --apply-after-go
```

These are separate deliberate operator invocations, not an activation script.
The flag is an explicit local write opt-in, not an authority grant. Each stage
checks its full prerequisite inventory, creates a non-overwriting local intent
directory, issues exactly one API write, and verifies the resulting stage.
`create-*` use POST `/repos/Cloudgeni-ai/opengeni/rulesets`; `admit` uses PUT of
`admission.json` to the snapshotted `admissionId`. See [stage.sh](stage.sh) for the
exact calls. API responses/errors stay in unique per-action attempt directories;
validated creation receipts are retained separately, never overwritten by errors.
Before any write, the corresponding parallel payload must exactly match the
verified `plan.json`; divergence aborts before a remote mutation. The actual body
is generated from that plan into the attempt's retained `request.json`, with the
method and exact endpoint in `request-meta.json`. A changed copy cannot weaken a
guard before the later readback notices.
Readback verification compares the **entire**
ruleset inventory (production/tags/inherited rules included), unchanged repository
merge settings and classic protections. Read the effective rules with
`gh api /repos/Cloudgeni-ai/opengeni/rules/branches/main` and the corresponding
`queue%2Flive%2F<existing-candidate-id>` / `batcher-state` branch endpoints when
those refs exist. Absence of refs is not proof the patterns fail or succeed.

Land the conditional AGENTS instructions before this transition. Full-inventory
checks print `manual` for original/restored, `hold` for partial guard/namespace
stages, and `queue-only` for applied. The rollout owner retains the current
receipt for audit. Ordinary agents use the readable procedure below, not access
to the operator's private `ADMIN_DIR`. Instructions become queue-only when the
complete active rules are observed, and do not revert merely because runtime stops.

### Agent-readable merge mode

These are read-only calls; no administrator token or local rollout receipt is
required merely to decide the merge path. Use the agent's authorized repository
read access. Fetch fresh effective main rules and the full inventory:

```sh
gh api repos/Cloudgeni-ai/opengeni/rules/branches/main
gh api --paginate 'repos/Cloudgeni-ai/opengeni/rulesets?includes_parents=true&per_page=100'
gh api repos/Cloudgeni-ai/opengeni
```

For every inventory entry, read its actual source-specific details: repository
rules at `repos/OWNER/REPO/rulesets/ID`, organization rules at
`orgs/ORG/rulesets/ID`. IDs/source come from the inventory, never guessed from a
name. Follow pagination; an unsupported/inaccessible inherited source is unknown,
not absent. Check classic branch protections using the read-only GraphQL query
in `read.sh` (including `hasNextPage`); effective rules alone do not establish
classic protection or reveal every bypass. Read rule types, active enforcement,
main/ref conditions and parameters—not names alone. GitHub may omit
`bypass_actors` for callers without ruleset write access. This expected missing
key is not malformed or inaccessible effective policy; do not require a stronger
token just to choose the safe merge path. If bypass data is visible and unexpected,
report the drift rather than ignore it.

- **Manual:** original/restored main protection is squash-only PR admission plus
  non-fast-forward and deletion protection; repository squash merging is enabled,
  all original PR requirements still apply, and there is no main creation/update
  writer restriction or partially installed batcher guard/namespace. Before first
  activation, this original policy is sufficient: do not demand an owner-local
  OFF receipt that cannot yet exist. Respect all other required checks/protections
  and use normal head-pinned squash, never an admin bypass.
- **Queue-only:** the readable effective policy and complete inventory show the
  intended main creation/update writer restriction
  (`update_allows_fetch_and_merge=false`, or exactly `{type:"update"}` with
  parameters absent), PR admission and separate immutable
  non-FF/deletion protection with the expected active scopes. Ordinary agents may
  safely queue rather than directly merge even when `bypass_actors` is omitted.
  This does not certify the App identity or hidden bypass scope, grant activation
  authority, or permit signalling readiness before the owner's intake go.
- **Hold:** mixed/partial rules, missing/inaccessible required readbacks, unknown
  sources, unexpected actors or configuration drift. Ask the rollout owner for
  the missing evidence; do not infer manual from a failed read or queue-only from
  the presence of a named ruleset. A stopped controller does not change this mode.

The same visible-policy decision applies to both ordinary and administrative
readers; the absence of hidden fields alone does not change it:

| Complete visible policy | Reader bypass data | Agent merge mode |
| --- | --- | --- |
| Original squash PR + non-FF/deletion; no writer restriction/partial transition | omitted | manual |
| Original squash PR + non-FF/deletion; no writer restriction/partial transition | visible and expected | manual |
| Complete intended writer restriction + admission + immutable guard | omitted | queue-only |
| Complete intended writer restriction + admission + immutable guard | visible and expected | queue-only |
| Mixed or inaccessible effective policy | omitted | hold |

The rollout owner still uses exact original snapshots and the full `verify`
routine for mutations/OFF, with administrative readbacks proving the assigned
App Integration and OrganizationAdmin are exactly the admission/writer bypasses; the immutable guard has
**no bypass actors**. Those exact identity/bypass checks are activation gates,
not prerequisites for an ordinary agent to choose queue-only rather than merge.
This agent readback is observational and grants no
ruleset, queue/state-ref, controller, rerun or cancellation authority. Recheck
before a manual merge; a readback is not an atomic fence against a later policy
transition, so normal GitHub enforcement remains authoritative.

For a timeout or failed post-write readback, use these **read-only remote** stages:

```sh
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reconcile-guard
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reconcile-namespace
# Ambiguous admit PUT: reconcile a stable applied state; otherwise observe before.
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reconcile-admit
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check-stable namespace
```

Choose the single relevant action, not all four blindly. Reconciliation uses a
concrete jq selection of exact name + repository ownership, requires exactly one
match, then validates its payload **and the entire inventory** before retaining
the receipt. If the first snapshot has zero matches, it waits 30 seconds and reads
again. Two empty observations are **not proof** a timed-out POST can never appear:
the intent stays blocked, no POST is repeated, and the operator must resolve the
provider outcome before a separately reviewed new attempt. Multiple matches or
drift also block. All snapshots/failed raw responses are retained. Re-entry after
confirmed success uses the next stage; the existing intent prevents accidentally
replaying the previous write even if the process died before saving its receipt.

For PUT/DELETE, `check-stable PHASE` requires two exact full-inventory readbacks
separated by 30 seconds. `reconcile-admit` checks `applied` twice and records the
forward admission intent as observed complete. If an ambiguous forward admission
still reads `namespace`, **keep both protective rulesets**: two absent observations
cannot prove an in-flight PUT will never land. Deletes are refused while that
forward intent remains unresolved. Resolve its provider outcome with the admin/
rollout owner; do not erase the intent or mark it verified manually. This is an
explicit safe hold, not a claim that REST readbacks provide a transaction fence.

## Controller enable and one-command OFF

For the separately scheduled recovery design, see the
[independent watchdog contract](watchdog.md). Its prepared payloads and pure
policy are not a deployed provider adapter or live kill-test qualification.

Only after ruleset readbacks, App permissions, the qualified continuous runtime,
capacity observation and the separate release/activation go are satisfied, the
deployment owner may configure the reviewed portable entrypoint:

```sh
BATCHER_REPOSITORY=Cloudgeni-ai/opengeni \
BATCHER_BASE_BRANCH=main \
BATCHER_BRANCH_PREFIX=queue/live/ \
BATCHER_MODE=active \
BATCHER_MAX_INFLIGHT=1 \
BATCHER_MAX_BATCH_SIZE=16 \
BATCHER_SPECULATION_DEPTH=2 \
BATCHER_GIT_DIR=/data/batcher.git \
bun scripts/merge-batcher/main.ts run
```

Supply the App variables by secret injection, plus explicitly qualified runner
budget/reserve values documented in [the controller guide](../merge-batcher.md).
The active state ref is fixed at `refs/heads/batcher-state`; this is not a cloud
lock or a new approval ceremony. Do not reuse the traffic-shadow state or prefix.
Do not copy the shell example into the old guarded read-only image. The chosen
service manager must have a tested stop operation and must not restart an active
process after rollback.

**STOP alone is not OFF:** exclusive main remains unavailable to normal manual
merges until exact policy restoration succeeds. The checked-in [off.ts](off.ts)
combines the deployment owner's reviewed STOP with the reverse ruleset stages.
First bind the exact reviewed control directory and its real deployed receipt,
offline, with no cloud writes:

```sh
bun docs/merge-batcher-admin/off.ts bind-stop "$ADMIN_DIR" "$REVIEWED_CONTROL_DIRECTORY"
```

That directory must contain the deployment owner's reviewed `control.ts`,
`cloud-auth.ts`, `service-config.ts`, `service-limits.ts`,
`stopped-reconciliation.ts` and `deployment-receipt.json`. The binding records all
five source hashes and the exact
service UID/image/URI in `stop-contract.json`. It never guesses a service identity.
Review the source/dependency closure and binding together; if the runtime owner
adds imports or changes the STOP interface, qualify a new adapter rather than
assuming this contract remains valid. Binding is not review or deployment proof.

After the separate emergency/turn-off authorization, the **single OFF command** is:

```sh
bun docs/merge-batcher-admin/off.ts run "$ADMIN_DIR" --apply-after-go
```

It executes only the pinned `control.ts stop`, which persists STOP, drains/disables
the writer and emits a JSON receipt. GitHub reads happen **after STOP** so a GitHub
outage cannot prevent stopping the already-bound runtime. Restoration requires a
confirmed drained or previously proven disabled outcome, persistent STOP,
manual-zero, no tagged revision uncertainty, no forced outcome, stable state SHA
and a matching deployment stop proof. The existing clean `verified-disabled`
path remains unchanged. An explicit `reconciled-disabled` alternative requires
the pinned operator's complete read-only reconciliation proof, matching retained
exit witness (UID, provider generation, mode, instance and STOP generation),
matching receipt/proof, stable state SHA, valid main/candidate refs and bounded
completed-effect count. A status string or desired instance count alone is not
proof. The operator checks the same current provider generation/routing and
reads the exact durable ledger/main/refs twice; the wrapper validates that
bound result against its deployment receipt. Pending/submitting/uncertain/blocked
effects, missing exit witness, changed state/generation or incomplete reads still
hold. This path neither restarts a writer nor cancels hosted CI, replays effects,
or fabricates clean runtime flags. Old four-file bindings require a newly reviewed
five-file binding, not editing a saved hash to bypass the check.
Unknown/forced results retain STOP and protections; they do not claim the manual path works.
These proofs cover the observed interval, not a later administrator's actions.
The real active STOP contract, including uninitialized state behavior, must be
qualified by the runtime owner before the live drill. If local source/identity
binding drift prevents the wrapper from starting, use that owner's emergency STOP
directly and reconcile; do not edit hashes to bypass review.

Then OFF detects the exact live stage, reconciles an observed-but-unrecorded
admission success, restores original admission, removes only the two exact
receipt-owned added rulesets, and verifies the complete restored inventory twice.
Only then it emits `off-verified.json` with `mergeMode: manual`. Publish that
receipt so the conditional AGENTS instructions immediately resume the normal
reviewed squash path. It never edits AGENTS via an emergency main push.

Every invocation retains separate STOP/stage output. Re-entry uses the **same
command and ADMIN_DIR**: already-completed stages are skipped; a failed reverse
PUT/DELETE uses the existing explicit reverse-only reissue with two delayed
pre-state readbacks and archived identical requests. No forward POST/admit is
replayed. An unresolved forward request or provider 422 can still block recovery;
the one-command interface cannot make REST atomic or hide that failure. Keep the
writer stopped and resolve it with the administrator before allowing manual
merges. An exclusive admin window remains required throughout. A crash-held
`plan/off-lock` needs owner inspection before removal, not a concurrent writer.

OFF does not cancel running CI, delete candidate/state refs, reset main, rotate
credentials, close PRs or restart shadow. Existing CI continues. Runtime image/
credential rollback and an optional shadow restart remain separately owned by the
deployment operator, after the old active writer is proven stopped. Production/
tags and full-main/release proof remain unchanged.

Never restart an older active controller against a ledger containing durable
parking records unless that exact binary has been reviewed as compatible. A
supervisor STOP alone leaves queue-only rules in place: the designated rules
operator owns the one-command OFF and verified Manual restoration, coordinated
with the sole runtime operator so STOP operations do not race.

The accepted landing contract remains an exact **tested snapshot**, not an atomic
lock on PR metadata. A later head can race the final reread. Exact landed SHA
comments/reconciliation must not claim that newer work was tested. An auto-merged
original with newer descendant work can receive an idempotently reconciled
follow-up PR; externally closed unmerged PRs cannot. Source access, API permission,
divergence or ambiguous creation can leave explicit blocked recovery. Every new
head/follow-up needs fresh required exact-head GitHub-hosted checks and readiness.
No VM attestation, agent comment or reviewer UUID is an admission requirement.
Version intake is a singleton with the same checks, never an automated exemption. Full
main CI and Version/image provenance still gate production release.

## Exact-prior ruleset restoration (OFF's underlying reverse stages)

Stop writers first. Verify `applied` against a **fresh** snapshot. Restore original
admission before removing either protective ruleset; verify after every call:

```sh
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" restore-admission --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" delete-namespace --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" delete-guard --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check-stable restored
```

Run each separately and stop on failure. These reverse steps use PUT `restore.json`
to the retained admission ID, then DELETE only the exact validated creation-receipt
IDs. For partial setup, concrete entry points are:

```sh
# If namespace was created but admission was not changed:
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check namespace
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" delete-namespace --apply-after-go
# If only guard remains (or guard was the only completed creation):
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check guard
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" delete-guard --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" check-stable restored
```

After ambiguous restore PUT, use `check-stable namespace` for the restored
admission state or `check-stable applied` for the unchanged state (including a
possible 422). After ambiguous namespace DELETE, `check-stable guard` observes its
absence; `check-stable namespace` observes it still present. After ambiguous guard
DELETE, `check-stable restored` observes full restoration; `check-stable guard`
observes it still present. Neither matching means drift: stop. A check never
replays a mutation. Repeat `check-stable restored` at the end of rollback that
began with an ambiguous write; final guard deletion also performs that delayed
readback itself. These observations do not fence another administrator or prove
provider finality, so the exclusive admin window and stopped writers still matter.

**Transient reverse-stage failure with the exact pre-state still present:** use
one of these separately named idempotent reissue actions, not the original stage:

```sh
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reissue-restore-admission --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reissue-delete-namespace --apply-after-go
bash docs/merge-batcher-admin/stage.sh "$ADMIN_DIR" reissue-delete-guard --apply-after-go
```

Choose only the failed reverse action. Each requires an existing retained attempt,
two delayed exact pre-state readbacks, and byte-identical generated request body,
method and endpoint. It archives the previous attempt under a unique
`ACTION-archive.*/attempt` directory, retaining response/error/evidence, before
issuing exactly one identical PUT or DELETE. A per-action local lock serializes
reissues on that plan; it is not a remote administration fence. This is safe with
respect to a late copy of that same idempotent reverse request, but not arbitrary
concurrent policy edits. A changed readback or request aborts without another
write. **POST/create and forward admission have no reissue action.** Existing
intents are never erased. A crash-held local reissue lock needs owner inspection,
not blind deletion or another writer. Unknown or legacy attempts lacking their
exact request metadata require separately reviewed manual recovery.

Never restore over another administrator's changed policy or delete by
name alone. Exact original configuration restores its original administrator
bypass as well; it is not a claim that the old policy had stronger guards. No App
uninstallation, secret revocation, branch deletion or CI cancellation is implied.

## Local validation and API references

```sh
bun test --max-concurrency 2 scripts/merge-batcher-admin*.test.ts
node node_modules/typescript/bin/tsc -p docs/merge-batcher-admin/tsconfig.json
```

References: [GitHub App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[repository rulesets REST API](https://docs.github.com/en/rest/repos/rules),
[available branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
Static tests do not qualify a live App/installation/ruleset or image. That remains
an explicitly authorized operator exercise, not evidence fabricated by this PR.
