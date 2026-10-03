## Summary

-

## Testing

- [ ] `bun run typecheck`
- [ ] `bun test`

## External API impact

See `docs/design/api-compatibility-policy.md`. Pick one:

- [ ] None: no public route, request/response shape, event type, or `@opengeni/sdk`/`@opengeni/react` export changes (internal cutovers, web-only routes, and migrations count as none).
- [ ] Additive only: `bun run public-api:refresh` committed; old SDKs keep working (`bun run test:sdk-compat`).
- [ ] Breaking: deprecation announced with `Deprecation`/`Sunset` headers, old behaviour kept at least 90 days on the managed service, entry in `scripts/public-api/breaking-changes.json`, and an `"@opengeni/sdk": major` changeset with migration notes.

## Delivery integrity

- [ ] Candidate/version labels represent substantive source changes, not base-only refreshes.
- [ ] If `main` advanced, I kept the candidate head frozen and verified mergeability/material compatibility, or documented the actual conflict/incompatibility that required a source change. Freeze-head source admission is required only for `hotfix/*` into `production`.

## Notes

-
