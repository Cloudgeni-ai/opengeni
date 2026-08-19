---
"@opengeni/db": patch
"@opengeni/core": patch
---

Let a managed human use the session surface inside their own personal workspace, without widening the owner-only exception to anyone else.

A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one) — their access is the `organization_memberships.personal_workspace_id` pointer. Three session seams fenced on a bare membership probe and therefore denied the one human who always belongs: `GET /v1/workspaces/:id/sessions` returned **403** so the workspace looked empty, `PUT …/sessions/:id/pin` returned **403**, and `PUT …/new-session-draft` returned **403**.

`subjectHasLiveWorkspaceAuthorityInScope` (`packages/db/src/workspace-authority.ts`) is now the single implementation of the corrected rule. Unlike the exported `subjectHasLiveWorkspaceAuthority`, it never sets `opengeni.subject_id` and raises if the requested subject differs from the transaction's authenticated scope, so it cannot be used as an arbitrary-subject oracle.

The exception additionally requires positive canonical managed-cookie provenance: `AccessGrantAuthorization.canonicalManagedHumanSession`, stamped only inside the one branch of `resolveAccessContext` that verified a Better Auth cookie. Inspecting a grant's shape would not do — a delegated bearer chooses its own `principalKind`, `metadata.delegated`, and `subjectId` claims. Bearer/delegated principals, API keys, service initiators, same-organization co-members, and organization or account administrators all fail closed, as does any authentication path added later.
