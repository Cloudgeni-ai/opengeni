# Versions and upgrades

## Pick a version

- Install the current stable release: `npm view @opengeni/sdk version` prints
  the npm `latest` version. Pin `@opengeni/sdk`, `@opengeni/react` and any
  other `@opengeni/*` package to that exact version (no `^` or `~` ranges).
- Do not use canary versions (`-canary.` in the version) in production.
- Source code, changelogs or docs can mention a newer version than npm
  `latest`. That version is not published yet; use npm `latest`.
- If the repository enforces a minimum release age, pin an older shared
  version or ask the user; do not bypass the policy.

## What stays compatible

Opengeni server updates do not break existing integrations. The routes,
fields, event types and documented behaviour that a published SDK uses keep
working, so a pinned version keeps working against app.opengeni.ai. Upgrade
for new features or fixes, not to stay compatible. Policy:
[api-compatibility-policy.md](https://github.com/Cloudgeni-ai/opengeni/blob/main/docs/design/api-compatibility-policy.md).

Write code that keeps it that way:

- Ignore unknown event types, enum values and response fields. Give every
  `switch` over an Opengeni union a default branch.
- Branch on error codes and typed SDK errors, not on message text.
- Members marked `@deprecated` keep working. Use the replacement their docs
  name in new code; existing calls need no urgent migration.

Self-hosted: run a server at least as new as the SDK. An older SDK works with
a newer server, but a newer SDK can call routes an older server does not have
yet. `/healthz` reports the server's `serverVersion`.

## Upgrade

1. Move every `@opengeni/*` package to the same new version in one change.
2. Read the `CHANGELOG.md` entries of `@opengeni/sdk` and `@opengeni/react`
   between the two versions.
3. Run the typecheck and tests, then send a real chat turn through the proxy.

If something that worked stops working after an Opengeni server update, that
is an Opengeni bug. Report the SDK version, `serverVersion`, route and error;
do not work around it by calling the HTTP API directly.
