#!/usr/bin/env bash
# Sourceable definitions only: no API call or shell-option change on source.
# Every remote operation here is GET or a read-only GraphQL query.
batcher_snapshot() (
  set -euo pipefail
  umask 077
  local capture id source_type source endpoint
  capture=$(mktemp -d "$ADMIN_DIR/readback.XXXXXX")
  gh api /repos/Cloudgeni-ai/opengeni > "$capture/repository-raw.json"
  jq '{full_name,default_branch,allow_squash_merge,allow_auto_merge,allow_merge_commit,allow_rebase_merge}' \
    "$capture/repository-raw.json" > "$capture/repository.json"
  gh api --paginate '/repos/Cloudgeni-ai/opengeni/rulesets?includes_parents=true&per_page=100' > "$capture/pages.json"
  jq -se 'if length > 0 and all(.[]; type == "array") then add | if length > 0 then . else error("Empty rules inventory") end else error("Missing rules inventory") end' "$capture/pages.json" > "$capture/list.json"
  jq -r '.[] | [.id,.source_type,.source] | @tsv' "$capture/list.json" > "$capture/details.tsv"
  while IFS=$'\t' read -r id source_type source; do
    case "$source_type" in
      Repository) endpoint="/repos/$source/rulesets/$id" ;;
      Organization) endpoint="/orgs/$source/rulesets/$id" ;;
      *) echo 'Unsupported inherited rule source: stop for review' >&2; exit 1 ;;
    esac
    gh api "$endpoint" > "$capture/rule-$id.json"
  done < "$capture/details.tsv"
  # A missing/inaccessible inventory is never interpreted as empty protection.
  jq -s '.' "$capture"/rule-*.json > "$capture/rulesets.json"
  gh api graphql -f query='query { repository(owner:"Cloudgeni-ai",name:"opengeni") { branchProtectionRules(first:100) { nodes { id pattern } pageInfo { hasNextPage } } } }' > "$capture/classic-raw.json"
  jq -e 'if .errors then error("GraphQL protection query failed") else .data.repository.branchProtectionRules end' "$capture/classic-raw.json" > "$capture/classic.json"
  jq -n --slurpfile repository "$capture/repository.json" --slurpfile rulesets "$capture/rulesets.json" --slurpfile classic "$capture/classic.json" \
    '{repository:$repository[0],rulesets:$rulesets[0],classic:$classic[0]}' > "$capture/snapshot.json"
  printf '%s\n' "$capture/snapshot.json"
)

batcher_identity() (
  set +x
  set -euo pipefail
  unset GH_DEBUG
  umask 077
  : "${APP_ID:?Assigned App ID required}" "${INSTALLATION_ID:?Assigned installation ID required}"
  : "${APP_JWT:?App JWT required}" "${INSTALLATION_TOKEN:?Installation token required}"
  local capture header
  capture=$(mktemp -d "$ADMIN_DIR/identity.XXXXXX")
  # curl's @file header input keeps the JWT out of process argv. The private
  # header is removed on success or failure; raw identity responses are retained.
  header="$capture/authorization.header"
  trap 'rm -f -- "$header"' EXIT
  printf 'Authorization: Bearer %s\n' "$APP_JWT" > "$header"
  unset APP_JWT
  curl --disable --silent --show-error --fail --header "@$header" \
    https://api.github.com/app > "$capture/app.json"
  curl --disable --silent --show-error --fail --header "@$header" \
    "https://api.github.com/app/installations/$INSTALLATION_ID" > "$capture/installation.json"
  GH_TOKEN="$INSTALLATION_TOKEN" gh api --paginate /installation/repositories > "$capture/repositories.json"
  jq -e --argjson app "$APP_ID" '.id == $app and .owner.login == "Cloudgeni-ai"' "$capture/app.json" >/dev/null
  jq -e --argjson app "$APP_ID" --argjson installation "$INSTALLATION_ID" \
    '.id == $installation and .app_id == $app and .account.login == "Cloudgeni-ai" and .repository_selection == "selected" and .suspended_at == null' "$capture/installation.json" >/dev/null
  jq -se '[.[].repositories[].full_name] == ["Cloudgeni-ai/opengeni"]' "$capture/repositories.json" >/dev/null
  jq -e --slurpfile manifest "$BATCHER_ADMIN_CODE/app-manifest.json" \
    '(.permissions | del(.metadata)) == $manifest[0].default_permissions and .permissions.metadata == "read"' "$capture/installation.json" >/dev/null
  jq -n --slurpfile app "$capture/app.json" --slurpfile installation "$capture/installation.json" \
    '{appId:$app[0].id,installationId:$installation[0].id,permissions:$installation[0].permissions,repository:"Cloudgeni-ai/opengeni"}' > "$capture/identity-receipt.json"
  cp "$capture/identity-receipt.json" "$capture/identity-receipt.next"
  mv "$capture/identity-receipt.next" "$ADMIN_DIR/identity-receipt.json"
  printf 'Verified identity readback: %s\n' "$capture"
)
