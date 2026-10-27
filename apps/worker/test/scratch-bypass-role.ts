// Cleanup for the scratch BYPASSRLS login role that sandbox-lease.test.ts
// creates on the shared test PostgreSQL cluster.
//
// While such a role is a member of opengeni_app, migrations that copy grants
// to every role inheriting app privileges (for example 0934) give it direct
// grants in whatever databases they run in: other tests' databases and
// templates included. Its own `DROP ROLE` then fails ("some objects depend on
// it"), and a leftover member of opengeni_app makes every other run's role
// provisioning refuse to normalize opengeni_app. So cleanup goes in order:
// memberships first (always possible, and enough to stop the damage), then
// its privileges in the harness's own `og_` databases, then DROP ROLE. Every
// step is best effort and never throws.
import postgres from "postgres";

export const SCRATCH_BYPASS_ROLE_PATTERN = "^opengeni_bypass_[0-9a-f]{32}$";

type Sql = postgres.Sql;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Remove `role`'s memberships, revoke its privileges in `og_` databases and
 * drop it. Returns notes for anything left behind (empty when the role is
 * gone). `adminUrl` is a superuser URL on the same cluster; its database part
 * is replaced per database.
 */
export async function dropScratchBypassRole(
  admin: Sql,
  adminUrl: string,
  role: string,
): Promise<string[]> {
  const notes: string[] = [];
  const note = (step: string, error: unknown) =>
    notes.push(`${role}: ${step}: ${error instanceof Error ? error.message : String(error)}`);
  try {
    const memberships = await admin<{ granted: string; member: string; grantor: string }[]>`
      SELECT g.rolname AS granted, m.rolname AS member, gr.rolname AS grantor
        FROM pg_auth_members am
        JOIN pg_roles g ON g.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        JOIN pg_roles gr ON gr.oid = am.grantor
       WHERE g.rolname = ${role} OR m.rolname = ${role}`;
    for (const { granted, member, grantor } of memberships) {
      const revoke = `REVOKE ${quoteIdent(granted)} FROM ${quoteIdent(member)}`;
      // GRANTED BY another role needs PostgreSQL 16.
      await admin
        .unsafe(`${revoke} GRANTED BY ${quoteIdent(grantor)}`)
        .catch(() => admin.unsafe(revoke));
    }
  } catch (error) {
    note("revoking memberships", error);
  }
  try {
    const databases = await admin<{ datname: string }[]>`
      SELECT DISTINCT d.datname
        FROM pg_shdepend s
        JOIN pg_roles r ON r.oid = s.refobjid AND s.refclassid = 'pg_authid'::regclass
        JOIN pg_database d ON d.oid = s.dbid
       WHERE r.rolname = ${role} AND d.datallowconn AND starts_with(d.datname, 'og_')
       ORDER BY d.datname`;
    for (const { datname } of databases) {
      const url = new URL(adminUrl);
      url.pathname = `/${datname}`;
      const target = postgres(url.toString(), {
        max: 1,
        connect_timeout: 10,
        onnotice: () => undefined,
        connection: { lock_timeout: 2000, statement_timeout: 30_000 },
      });
      try {
        // The role owns nothing, so this only revokes its privileges.
        await target.unsafe(`DROP OWNED BY ${quoteIdent(role)}`);
      } catch (error) {
        // Dropped meanwhile: nothing left to revoke there.
        if ((error as { code?: unknown })?.code !== "3D000") note(`revoking in ${datname}`, error);
      } finally {
        await target.end({ timeout: 5 }).catch(() => undefined);
      }
    }
  } catch (error) {
    note("listing its databases", error);
  }
  try {
    await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  } catch (error) {
    note("dropping", error);
  }
  return notes;
}

/**
 * Clean up scratch bypass roles that earlier, killed runs left behind: roles
 * matching `pattern` with no connection now and again after `recheckMs`. A
 * live run holds its role's connection from its first query until its own
 * cleanup, so a role unused across the recheck is not in use. Returns the
 * roles it removed. Never throws.
 */
export async function reapStaleBypassRoles(
  admin: Sql,
  adminUrl: string,
  options: { pattern?: string; recheckMs?: number } = {},
): Promise<string[]> {
  const pattern = options.pattern ?? SCRATCH_BYPASS_ROLE_PATTERN;
  const idle = async () => {
    const rows = await admin<{ rolname: string }[]>`
      SELECT r.rolname FROM pg_roles r
       WHERE r.rolname ~ ${pattern}
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usesysid = r.oid)`;
    return new Set(rows.map((row) => row.rolname));
  };
  const removed: string[] = [];
  try {
    const first = await idle();
    if (first.size === 0) return removed;
    await Bun.sleep(options.recheckMs ?? 15_000);
    const second = await idle();
    for (const role of first) {
      if (!second.has(role)) continue;
      const notes = await dropScratchBypassRole(admin, adminUrl, role);
      if (notes.length === 0) removed.push(role);
      else console.warn(`stale bypass role cleanup: ${notes.join("; ")}`);
    }
  } catch (error) {
    console.warn(`stale bypass role cleanup skipped: ${String(error)}`);
  }
  return removed;
}
