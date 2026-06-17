#!/usr/bin/env bash
# Publish the client packages to npm with provenance.
#
# Invoked by changesets/action ONLY when a "Version Packages" PR is merged (i.e.
# there are released versions to publish). It is intentionally guarded so a
# missing NPM_TOKEN does not red-fail the workflow: self-hosters fork this repo
# without the @opengeni npm org, and GHCR image publishing must still succeed.
#
# Publishing goes through `changeset publish`, which runs `npm publish` per
# package and honors each package.json `publishConfig` ({ access: "public",
# provenance: true }). We use npm (not bun) because bun cannot emit npm
# provenance. NPM_CONFIG_PROVENANCE=true is set by the workflow env.
set -euo pipefail

if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "release:publish — NPM_TOKEN/NODE_AUTH_TOKEN is not set; skipping npm publish."
  echo "Set the NPM_TOKEN repo secret and create the @opengeni npm org to enable publishing."
  exit 0
fi

# Ensure fresh dist/ + .d.ts for the tarballs and re-assert the closure guard
# right before bytes leave the building.
bun run build:packages
bun scripts/publish-closure-guard.ts

# Rewrite `workspace:*` specs in the publishable packages to concrete `^x.y.z`
# ranges. This MUST run after `changeset version` (which already bumped the
# package.json versions in the CI checkout) and right before publish: the plain
# `npm publish` that `changeset publish` falls back to in this bun workspace
# does NOT strip the workspace: protocol, so without this the published
# @opengeni/react would carry `"@opengeni/sdk": "workspace:*"` and be
# uninstallable. The edit is confined to the ephemeral CI checkout and is never
# committed; run with `--restore` locally to undo it.
bun scripts/rewrite-workspace-deps.ts

# changeset publish reads publishConfig (access: public, provenance: true) from
# each package and runs `npm publish` with provenance under the hood.
npx changeset publish
