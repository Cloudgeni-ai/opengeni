## Summary

-

## Testing

- [ ] `bun run typecheck`
- [ ] `bun run test:unit` (process-isolated; plus full relevant real-service/browser suites)
- [ ] Independent agent review of the current head; reviewer session and command/results evidence posted in a PR comment.
- [ ] Any budget/threshold/skip/coverage relaxation is explicit, reviewer-confirmed, and labelled `test-policy-change` (or none).

## External API impact

Existing integrations must keep working. See `docs/design/api-compatibility-policy.md`. Pick one:

- [ ] None: no public route, request/response shape, event type, documented behaviour, or `@opengeni/sdk`/`@opengeni/react` export changes (internal cutovers, web-only routes, and migrations count as none).
- [ ] Additive only: old behaviour and defaults unchanged; `bun run public-api:refresh` committed.
- [ ] Approved exception (security fix or recorded owner approval): linked in `scripts/public-api/breaking-changes.json`, the policy's exception log and the changeset, with migration notes.

## Delivery integrity

- [ ] Candidate/version labels represent substantive source changes, not base-only refreshes.
- [ ] If `main` advanced, I kept the candidate head frozen and verified mergeability/material compatibility, or documented the actual conflict/incompatibility that required a source change. Freeze-head source admission is required only for `hotfix/*` into `production`.
- [ ] I queue it with `queue-ready` (or auto-merge) after exact-head review evidence and never merge directly or bypass the batcher. Control-plane changes have explicit independent control-plane review. See `docs/merge-batcher.md`.

## Notes

-
