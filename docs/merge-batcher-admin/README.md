# Prepared administration bundle — inactive

This bundle **does not apply configuration**. `bundle.ts` is offline: it reads
saved JSON and creates payloads/readback assertions only. The API write examples
below are for an authorized repository administrator **after a separate rollout
go**. Publishing this documentation, creating an App, or permitting candidate-only
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
| Existing `Protection`, updated in place | Existing default-branch condition (`main` required) | Dedicated App, `Integration`, `always` | Existing PR admission parameters, including squash-only manual merges, unchanged |
| `Opengeni batcher immutable refs` | `main`, `queue/live/**`, `batcher-state` | **None**, including administrators and the App | Non-fast-forward and deletion prohibited |
| `Opengeni batcher dedicated writer` | `queue/live/**`, `batcher-state` only | Dedicated App, `Integration`, `always` | Creation/update restricted to the App |

On **main**, the App bypasses PR admission only. Namespace creation/update bypass
authorizes its candidate/state writes; it does not bypass the separate immutable
guard. Lease commits descend from the previous state commit, so their CAS pushes
remain fast-forward despite the state-specific `--force-with-lease` wire option.
Main receives no force authorization. Candidate refs remain create-only in the
controller; the ruleset itself permits App FF updates and is not a substitute
for that implementation invariant.

The previous combined ruleset's broad administrator bypass is removed from main
admission, not copied into the guard. Ordinary collaborators retain the existing
normal squash PR merge path; this bundle does not require `Batch ready` on that
manual path or add linear-history enforcement (candidate commits have two
parents). It does not enable auto-merge. Production/tag rules, full-main CI and
release proof are unchanged. Diagnostic `queue/shadow-traffic/**` and shadow state
refs are deliberately outside these live namespaces. A credential with repository
contents write is not intrinsically branch-scoped: unchanged production/tag
protections and application behavior still matter. This is not an assertion of
universal branch confinement or inability of a repository administrator to edit
the rules later.

## Dedicated App registration and installation (manual, not performed here)

Use [app-manifest.json](app-manifest.json) as the exact registration specification.
In the **Cloudgeni-ai organization → Settings → Developer settings → GitHub Apps**,
register a private App with that name/homepage and only these repository grants:

- Contents **write**: fetch and atomic candidate/state/main Git transactions.
- Workflows **write**: commits can contain workflow-file changes.
- Actions **write**: read bound receipts and rerun the whole workflow once.
- Pull requests **write**: exact-head reconciliation and remaining-delta follow-up PRs.
- Issues **write**: exact-head evidence/ejection comments.
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

Before planning, an administrator/deployment owner supplies the assigned numeric
`APP_ID` and `INSTALLATION_ID`, an App JWT in `APP_JWT`, and a short-lived scoped
installation token in `INSTALLATION_TOKEN` through the secret mechanism (do not
echo them). With `umask 077`, save these **GET** readbacks outside the checkout:

```sh
set -euo pipefail
umask 077
ADMIN_DIR=$(mktemp -d /workspace/tasks/batcher-admin.XXXXXX)
export ADMIN_DIR
GH_TOKEN="$APP_JWT" gh api /app > "$ADMIN_DIR/app.json"
GH_TOKEN="$APP_JWT" gh api "/app/installations/$INSTALLATION_ID" > "$ADMIN_DIR/installation.json"
GH_TOKEN="$INSTALLATION_TOKEN" gh api --paginate /installation/repositories > "$ADMIN_DIR/installed-repositories.json"
jq -e --argjson app "$APP_ID" '.id == $app and .owner.login == "Cloudgeni-ai"' "$ADMIN_DIR/app.json"
jq -e --argjson app "$APP_ID" --argjson installation "$INSTALLATION_ID" \
  '.id == $installation and .app_id == $app and .account.login == "Cloudgeni-ai" and .repository_selection == "selected" and .suspended_at == null' \
  "$ADMIN_DIR/installation.json"
jq -se '[.[].repositories[].full_name] == ["Cloudgeni-ai/opengeni"]' "$ADMIN_DIR/installed-repositories.json"
jq -e --slurpfile manifest docs/merge-batcher-admin/app-manifest.json \
  '(.permissions | del(.metadata)) == $manifest[0].default_permissions and .permissions.metadata == "read"' \
  "$ADMIN_DIR/installation.json"
```

Stop if any assertion fails. These checks establish identity/configuration, not a
successful active Git transaction. The App must not be placed into another
bypass group. Human admin credentials for later ruleset changes need repository
Administration write and organization authority to install the App; the runtime
App deliberately has no Administration write. The repository must support active
rulesets for this plan; inherited restrictions cannot be bypassed by changing a
repository rule.

## Capture exact prior configuration and generate offline payloads

Use an administrator's authorized `gh` context for complete bypass readbacks, not
the runtime App token. Keep snapshots/receipts private and retained outside Git.
Run from the reviewed repository checkout; require `bun`, `gh`, `jq` and Bash.
The function below makes only repository/organization GET requests and a read-only
GraphQL query. Each invocation retains a fresh raw inventory and every detail.

```bash
set -euo pipefail
umask 077
snapshot() {
  local capture id source_type source endpoint
  capture=$(mktemp -d "$ADMIN_DIR/readback.XXXXXX") || return
  gh api /repos/Cloudgeni-ai/opengeni > "$capture/repository-raw.json" || return
  jq '{full_name,default_branch,allow_squash_merge,allow_auto_merge,allow_merge_commit,allow_rebase_merge}' \
    "$capture/repository-raw.json" > "$capture/repository.json" || return
  gh api --paginate '/repos/Cloudgeni-ai/opengeni/rulesets?includes_parents=true&per_page=100' \
    > "$capture/pages.json" || return
  jq -s 'add' "$capture/pages.json" > "$capture/list.json" || return
  while IFS=$'\t' read -r id source_type source; do
    case "$source_type" in
      Repository) endpoint="/repos/$source/rulesets/$id" ;;
      Organization) endpoint="/orgs/$source/rulesets/$id" ;;
      *) echo 'Unsupported inherited rule source: stop for review' >&2; return 1 ;;
    esac
    gh api "$endpoint" > "$capture/rule-$id.json" || return
  done < <(jq -r '.[] | [.id,.source_type,.source] | @tsv' "$capture/list.json")
  jq -s '.' "$capture"/rule-*.json > "$capture/rulesets.json" || return
  gh api graphql -f query='query { repository(owner:"Cloudgeni-ai",name:"opengeni") { branchProtectionRules(first:100) { nodes { id pattern } pageInfo { hasNextPage } } } }' \
    > "$capture/classic-raw.json" || return
  jq -e '.data.repository.branchProtectionRules' "$capture/classic-raw.json" > "$capture/classic.json" || return
  jq -n --slurpfile repository "$capture/repository.json" --slurpfile rulesets "$capture/rulesets.json" --slurpfile classic "$capture/classic.json" \
    '{repository:$repository[0],rulesets:$rulesets[0],classic:$classic[0]}' > "$capture/snapshot.json" || return
  printf '%s\n' "$capture/snapshot.json"
}
BEFORE=$(snapshot) || exit 1
PLAN="$ADMIN_DIR/plan"
bun docs/merge-batcher-admin/bundle.ts prepare "$BEFORE" "$APP_ID" "$INSTALLATION_ID" "$PLAN"
sha256sum "$PLAN"/*.json
```

`prepare` refuses an existing output directory. It locates the unique
repository-owned `Protection` by its readback identity; no hardcoded live ruleset
IDs are shipped. It requires the observed active default-branch squash admission
shape and no classic protections. Unknown/missing rules or bypass fields fail
rather than silently lowering protection. Inspect **all** inherited/overlapping
rules and current ref permissions before go; matching JSON cannot prove a new
identity is accepted by GitHub. Future policy drift needs a new reviewed plan,
not a relaxed assertion. No production/tag change is proposed.

`plan.json` retains the complete before snapshot, App/installation IDs and payloads.
`restore.json` retains the original writable fields, including original bypass
actors and every PR parameter. API-generated timestamps/links are retained in
the raw snapshot but are not valid PUT fields. `guard.json`, `namespace.json`,
`admission.json` are concrete API JSON, not templates needing guessed actor IDs.

## Prepared API changes — administrator runs only after explicit go

Coordinate an exclusive admin change window and stop all live controllers first.
No transaction spans these REST calls; full inventory assertions detect drift but
cannot eliminate a last-moment concurrent administrator edit. Abort/reconcile if
that happens. Reconfirm identity/install permission receipts and the original
snapshot immediately before the first mutation. Guard first; admission last:

```sh
set -euo pipefail
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" original
# Only proceed when the preceding command succeeds and operator go is recorded.
gh api --method POST /repos/Cloudgeni-ai/opengeni/rulesets --input "$PLAN/guard.json" > "$PLAN/guard-receipt.json"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" guard

gh api --method POST /repos/Cloudgeni-ai/opengeni/rulesets --input "$PLAN/namespace.json" > "$PLAN/namespace-receipt.json"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" namespace

ADMISSION_ID=$(jq -er '.admissionId' "$PLAN/plan.json")
gh api --method PUT "/repos/Cloudgeni-ai/opengeni/rulesets/$ADMISSION_ID" --input "$PLAN/admission.json" > "$PLAN/admission-receipt.json"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" applied
```

Use one dedicated Bash shell with `set -euo pipefail`; a failed command must end
the sequence, not fall through to the next mutation. Execute each block only
after checking the prior result; these are not a blind
paste-and-run activation script. Readback verification compares the **entire**
ruleset inventory (production/tags/inherited rules included), unchanged repository
merge settings and classic protections. Read the effective rules with
`gh api /repos/Cloudgeni-ai/opengeni/rules/branches/main` and the corresponding
`queue%2Flive%2F<existing-candidate-id>` / `batcher-state` branch endpoints when
those refs exist. Absence of refs is not proof the patterns fail or succeed.

For a timeout/ambiguous POST, **do not repeat POST**. Take a new snapshot, find
exactly one repository-owned ruleset with the intended unique name, retrieve its
detail into the corresponding receipt file, then verify that stage. Zero or
multiple matches require operator reconciliation before proceeding. An ambiguous
PUT is reconciled by comparing the full inventory to the before/after stages,
not by assuming failure. Preserve all raw receipts; do not overwrite a valid
creation receipt with a retry's error output.

## Controller enable and one-step stop

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

**One-step operational rollback: stop/disable the active controller service** using
the deployment owner's tested service-manager stop command. This bundle cannot
name that cloud/service resource in advance. A portable foreground process can be
stopped with `kill -TERM "$BATCHER_PID"` only when that is its recorded owned PID
and no supervisor restarts it. SIGTERM stops new polls; an already executing
transaction can finish. Wait for every writer to exit and reconcile the state/main
tips before claiming rollback complete. Restart only with `BATCHER_MODE=shadow`
and the shadow-only entrypoint/configuration. Do not cancel running CI, delete
candidate/state refs, reset main, rotate credentials or close PRs. Normal manual
squash merges remain available under normal tests/review while the batcher is
stopped. Stopping the controller is distinct from restoring rulesets.

The accepted landing contract remains an exact **tested snapshot**, not an atomic
lock on PR metadata. A later head can race the final reread. Exact landed SHA
comments/reconciliation must not claim that newer work was tested. An auto-merged
original with newer descendant work can receive an idempotently reconciled
follow-up PR; externally closed unmerged PRs cannot. Source access, API permission,
divergence or ambiguous creation can leave explicit blocked recovery. Every new
head/follow-up needs fresh full VM tests, independent review and readiness. Version
intake is a singleton with the same evidence, never an automated exemption. Full
main CI and Version/image provenance still gate production release.

## Exact-prior ruleset restoration (separate admin action)

Stop writers first. Verify `applied` against a **fresh** snapshot. Restore original
admission before removing either protective ruleset; verify after every call:

```sh
set -euo pipefail
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" applied
ADMISSION_ID=$(jq -er '.admissionId' "$PLAN/plan.json")
gh api --method PUT "/repos/Cloudgeni-ai/opengeni/rulesets/$ADMISSION_ID" --input "$PLAN/restore.json" > "$PLAN/restore-receipt.json"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" namespace

NAMESPACE_ID=$(jq -er '.id' "$PLAN/namespace-receipt.json")
gh api --method DELETE "/repos/Cloudgeni-ai/opengeni/rulesets/$NAMESPACE_ID"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" guard

GUARD_ID=$(jq -er '.id' "$PLAN/guard-receipt.json")
gh api --method DELETE "/repos/Cloudgeni-ai/opengeni/rulesets/$GUARD_ID"
CURRENT=$(snapshot)
bun docs/merge-batcher-admin/bundle.ts verify "$PLAN" "$CURRENT" restored
```

For partial setup, start from its verified stage and reverse only completed steps:
`namespace` → delete that namespace → `guard` → delete that guard → `restored`;
`guard` → delete that guard → `restored`. For drift or ambiguous outcomes, stop and
reconcile; never restore over another administrator's changed policy or delete by
name alone. Exact original configuration restores its original administrator
bypass as well; it is not a claim that the old policy had stronger guards. No App
uninstallation, secret revocation, branch deletion or CI cancellation is implied.

## Local validation and API references

```sh
bun test --max-concurrency 2 scripts/merge-batcher-admin.test.ts
node node_modules/typescript/bin/tsc -p docs/merge-batcher-admin/tsconfig.json
```

References: [GitHub App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[repository rulesets REST API](https://docs.github.com/en/rest/repos/rules),
[available branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
and [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
Static tests do not qualify a live App/installation/ruleset or image. That remains
an explicitly authorized operator exercise, not evidence fabricated by this PR.
