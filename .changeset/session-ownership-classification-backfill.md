---
"@opengeni/db": minor
---

Add the OPE-204 phase D session ownership classification and backfill seam (migration 0294, rolling), plus `bun run db:backfill-session-ownership`.

The slice was scoped on a false premise. Sessions are not 100% owner-NULL: migration 0225's `guard_session_authority_write` trigger already derives session ownership on every INSERT, and `session_visibility_isolation` is live. 0285's `sessions.ownerless` count is the residue of that trigger's two INSERT-only branches, not a migration backlog - and part of it grows with every API-key or scheduled session.

Exactly two populations are deterministically repairable, and the backfill repairs only those: a session whose workspace is exactly one active membership's `personal_workspace_id` (a 1:1 anchor) and whose creator subject is that same membership - slice B deliberately provisions a personal workspace without a `workspace_memberships` row, so 0225's second branch cannot reach it - and the parent-inheritance closure that 0225's own first branch would have produced. Everything else is recorded unresolved with a fixed ledger reason code and never guessed: `service`-created sessions, non-`user:` subjects (`api_key:`/`configured:`) that 0219 and 0263 can never provision an organization anchor for, creators without a live membership, a personal-workspace anchor that disagrees with the creator, and - the largest refusal - an active human's session in an ordinary shared workspace, because replaying 0225's second branch retroactively would evaluate today's workspace grants against a historical session.

The backfill is dry-run by default, bounded by `--limit`, resumable through `FOR UPDATE ... SKIP LOCKED`, and idempotent. It writes only the owner pair behind 0225's own visibility-write capability: no `visibility`, `authority_epoch`, or `updated_at` change, no session event, and no read widened - every candidate is `workspace_shared`, which `session_visibility_isolation` short-circuits on. Receipt recording is `to_regprocedure`-guarded against the tenancy backfill ledger and reports `ledgerAvailable` plainly.

Both routines are `SECURITY DEFINER` capability-claiming seams rather than migration SQL for a structural reason (OPE-276): `sessions` is FORCE RLS, the documented deployment posture is a non-superuser migration principal without `BYPASSRLS`, and a plain migration-time `UPDATE sessions` therefore matches zero rows and reports success on such a deployment. The suite proves a non-zero attribution under a synthetic `NOSUPERUSER NOBYPASSRLS` owner.
