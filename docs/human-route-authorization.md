# Human and browser route authorization

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
transports: `/sessions/:sessionId/events` approvals and user decisions require
verified owning-user authority, including consenting native user delegation;
service identities and live agent attempts cannot manufacture that authority.
Skill decisions and filesystem-recovery acknowledgements are not browser-auth
ceremonies. Model policy and SuperGrok routes separately fence user
and shared subscription scopes. A route accepting one shared variant does not
authorize its private or consent variants.

The external identity-link `:operation` registration only implements preview,
confirm and revoke. Its native confirmation is independent consent, not an
opportunity for the external product to consent on the person's behalf.
Provider flow initiation/polling can delegate to the exact verified user; actual
provider consent or credential entry completes at the returned browser URL.
Provider code redemption, browser login/session changes, canonical
identity recovery, reset-credit payment confirmation and new native identity
binding consent remain independent browser ceremonies. Merely returning a
configuration or handoff link is not provider consent. GitHub installation
setup/callback redirects only advance signed state toward OAuth and are not
credential-redemption ceremonies. Sign-in-method enrollment initiation may
return a native browser handoff; committing a new login credential stays strict.
Checkout/portal link creation is not payment confirmation; the hosted payment
page still needs the person.

Organization-owned machine API keys, Fiken tokens and MCP bearer/header secrets
are scoped connection administration, not native browser authentication or
third-party user consent. They remain callable with live write authority and
the existing destination, secret-handling and ownership checks. Personal
connection configuration still requires the exact verified owner. Native login
passwords, account-recovery secrets and provider authorization-code redemption
are different: delegation never substitutes their independent ceremonies.

## Phase 2 delegation proof contract

The audit-only PR does not activate enforcement. Phase 2 provides a separate
request-local proof in `packages/core/src/access` for
the trusted OAuth dispatcher to stamp **after** grant verification. Never infer
that proof from headers, metadata, `principalKind`, service attribution or a
caller-supplied grant-shaped object. Never set `canonicalManagedHumanSession`
for delegation. `hasVerifiedOwningUserAuthorization` remains the single
owner-only predicate; resource/session checks still compare the exact owner.
Live organization membership, workspace scope and both permission ceilings
must be rechecked; an organization admin/key never inherits personal ownership.

The trusted OAuth verifier/dispatcher calls this exported API before resolving
access or dispatching the **same raw Request**:

```ts
stampDelegatedHumanAuthorization(request, {
  organizationId,
  subjectId: `user:${nativeUserId}`,
  permissions, // verified OAuth grant ceiling, not caller metadata
  workspaceScope: { kind: "selected", workspaceIds }, // or { kind: "all" }
});
```

The resolver reloads native access, intersects both ceilings and scope, and
stamps exact resolved authorization objects separately. Restamping, late
stamping, cloned requests and cloned grant/context objects fail closed.
Account permissions intersect literally; `workspace:admin` never confers
organization ownership, billing or key control. Personal settings additionally
need the proof's literal `workspace:admin` ceiling and the live exact owner;
this does not add the wildcard to a closed Personal grant. Tool gateway calls
recheck the same raw request's current native authority before provider use.

`requireVerifiedDelegatedHumanContext` exposes the native profile, subject and
live constrained context without a fabricated session or browser hash. Missing
native email verification remains unverified. No token issuance is implemented
here. The future OAuth verifier owns grant authenticity/revocation; the stamp
function is a trusted server capability, never a public HTTP handler.

## Coverage, findings and limits

`human-route-inventory.ts` parses registrations and follows local/imported gate
wrappers. The coverage test compares the independent source inventory with the
committed data, rejects duplicate or missing method/path entries and pins gate
coverage. Known gate symbols and provenance properties are explicit; new
human-gate forms must update discovery deliberately. Wildcard provider auth and
multi-operation registrations retain their source path, rather than inventing
individual provider endpoints. The snapshot includes route patterns outside
the SDK public surface because browser-only routes still need classification.

`missingGateCandidates` retains baseline ungated/shape-only findings, with
Phase 2 resolution status: mixed event approvals and hosted login initiation
require verified owning-user proof, billing link creation gets cookie-only CSRF admission,
and the Personal settings exception enforces a separate mutation ceiling.
An `organization_allowed` classification does not activate a database lifecycle
that currently only accepts native membership actors: retain its fail-closed
denial until the organization-key foundation supplies the corresponding live
authority seam. Do not impersonate an owner to work around it.

Out of scope: OAuth token issuance, organization-key policy migrations, the MCP
action catalog and browser UI. Consumers must use browser destinations for
person-present outcomes; raw API callback URLs are not safe handoff URLs.
Cross-organization creation and the global invitation cursor fail closed for a
single-organization delegation. Invitation acceptance checks its organization
before mutation and never auto-binds invitations across organizations.