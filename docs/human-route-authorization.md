# Human and browser route authorization (OPE-647)

`scripts/public-api/human-route-classification.json` is the reviewed inventory
of human/browser-gated HTTP registrations, including indirect helpers,
conditional ownership checks and ownership-sensitive response projections.
Each method/path has exactly one class, its source, gate functions and a reason.
The data is policy intent, **not an authorization capability**.

| Class | Non-cookie callers |
| --- | --- |
| `csrf_only` | Authenticated bearer or trusted in-process principal; normal permissions still apply. |
| `delegable_to_user` | Verified delegation to the exact person, capped by their live authority. Never an organization identity. |
| `organization_allowed` | Verified organization service or verified person delegation, within granted organization/workspace permissions. |
| `person_present` | Keep native browser, identity, recent-authentication and consent checks. MCP returns `open_in_browser`, never dispatches the ceremony. |

## Mixed routes and scope

The class describes the gated behavior, not a replacement for permission,
resource ownership, live membership, or provider commit-time checks. Shared
session lists still exclude another person's private sessions and Personal
workspace. `conditionalRestrictions` records stricter variants of mixed
transports: in particular `/sessions/:sessionId/events` must not let service or
delegated grants answer human tool approvals. Generic human-input answers are
not tool approval; credential/Skill-removal confirmation retains its canonical
person-present proof. Model policy and SuperGrok routes separately fence user
and shared subscription scopes. A route accepting one shared variant does not
authorize its private or consent variants.

The external identity-link `:operation` registration only implements preview,
confirm and revoke. Its native confirmation is independent consent, not an
opportunity for the external product to consent on the person's behalf.
Provider device-code start/poll, OAuth callbacks, login/session-set changes,
canonical identity recovery, reset-credit preparation/redemption, browser
identity linking and sandbox discontinuity consent remain browser handoffs.
Checkout/portal link creation is not payment confirmation; the hosted payment
page still needs the person.

## Delegation proof boundary

Phase 2 adds a separate request-local proof in `packages/core/src/access` for
the trusted OAuth dispatcher to stamp **after** grant verification. Never infer
that proof from headers, metadata, `principalKind`, service attribution or a
caller-supplied grant-shaped object. Never set `canonicalManagedHumanSession`
for delegation. `hasVerifiedOwningUserAuthorization` remains the single
owner-only predicate; resource/session checks still compare the exact owner.
Live organization membership, workspace scope and both permission ceilings
must be rechecked; an organization admin/key never inherits personal ownership.

## Coverage, findings and limits

`human-route-inventory.ts` parses registrations and follows local/imported gate
wrappers. The coverage test compares the independent source inventory with the
committed data, rejects duplicate or missing method/path entries and pins gate
coverage. Known gate symbols and provenance properties are explicit; new
human-gate forms must update discovery deliberately. Wildcard provider auth and
multi-operation registrations retain their source path, rather than inventing
individual provider endpoints. The snapshot includes route patterns outside
the SDK public surface because browser-only routes still need classification.

`missingGateCandidates` flags ungated/shape-only risks for focused follow-up,
including mixed event approvals and cookie CSRF on billing link creation.
An `organization_allowed` classification does not activate a database lifecycle
that currently only accepts native membership actors: retain its fail-closed
denial until the organization-key foundation supplies the corresponding live
authority seam. Do not impersonate an owner to work around it.

Out of scope: OAuth token issuance, organization-key policy migrations, the MCP
action catalog and browser UI. Consumers must use browser destinations for
person-present outcomes; raw API callback URLs are not safe handoff URLs.
Cross-organization creation/invitation acceptance cannot be performed with a
single-organization connection unless separately authorized by its grant model.