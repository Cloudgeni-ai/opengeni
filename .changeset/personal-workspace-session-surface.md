---
"@opengeni/db": patch
"@opengeni/core": patch
---

Let a managed human use the session surface inside their own personal workspace, without widening the owner-only exception to anyone else.

A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one) — their access is the `organization_memberships.personal_workspace_id` pointer. Three session seams fenced on a bare membership probe and therefore denied the one human who always belongs: `GET /v1/workspaces/:id/sessions` returned **403** so the workspace looked empty, `PUT …/sessions/:id/pin` returned **403**, and `PUT …/new-session-draft` returned **403**.

`subjectHasLiveWorkspaceAuthorityInScope` (`packages/db/src/workspace-authority.ts`) is now the single implementation of the corrected rule. It refuses to set `opengeni.subject_id`, which makes the arbitrary-subject oracle shape unrepresentable at these seams and keeps the authority read inside the caller's transaction and advisory fence.

**The authorization is not that resolver.** Neither it nor the exported `subjectHasLiveWorkspaceAuthority` establishes who the caller is — both answer "does subject X hold authority here". The one thing that authorizes the exception is `AccessGrantAuthorization.canonicalManagedHumanSession`, stamped only inside the branch of `resolveAccessContext` that verified a Better Auth cookie. Inspecting the grant would not do: a delegated bearer chooses its own `principalKind`, `metadata.delegated`, `serviceInitiator`, and `subjectId`. Bearer/delegated principals, API keys, service initiators, same-organization co-members, organization admins and owners, and account administrators all fail closed, as does any authentication path added later.
