// @opengeni/core ManagedAuth TYPE alias.
//
// WHY THIS MODULE LIVES IN CORE: `dependencies.ts` carries a `managedAuth?:
// ManagedAuth | null` passthrough slot and the access layer calls
// `managedAuth.api.getSession({ headers })`. Both are framework-agnostic, so
// they belong in @opengeni/core. The CONSTRUCTION of a real Better Auth
// instance — `createManagedAuth`, which opens its own `pg.Pool` and wires
// Resend — stays in `apps/api/src/auth/managed-auth.ts` (it pulls the `pg`
// driver, which must NEVER enter @opengeni/core).
//
// This is a TYPE-ONLY import of Better Auth's `Auth` generic: it is fully
// erased at build time (tsup `dts`/transpile drop it), so it adds NO runtime
// dependency and NO driver import to the published @opengeni/core tarball —
// `better-auth` is a devDependency for typecheck only. Keeping the alias as the
// exact `Auth<any>` shape (not a hand-narrowed structural type) means
// `apps/api/src/app.ts` — which uses `managedAuth.handler(...)` AND the
// passthrough `deps.managedAuth` — stays byte-identically typed.
import type { Auth } from "better-auth";

export type ManagedAuth = Auth<any>;
