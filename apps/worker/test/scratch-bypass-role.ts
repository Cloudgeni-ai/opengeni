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
// step is best effort, bounded in time, and never throws.
import { hostname } from "node:os";
import postgres from "postgres";

export const SCRATCH_BYPASS_ROLE_PATTERN = "^opengeni_bypass_[0-9a-f]{32}$";

type Sql = postgres.Sql;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove every membership of `role`, in both directions. Returns notes. */
async function revokeMemberships(admin: Sql, role: string): Promise<string[]> {
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
    return [];
  } catch (error) {
    return [`${role}: revoking memberships: ${message(error)}`];
  }
}

/**
 * Remove `role`'s memberships, revoke its privileges in `og_` databases and
 * drop it. A role that owns objects anywhere keeps them (and stays); a
 * template still being built (not yet marked as a template) is skipped; work
 * past `deadline` (epoch ms) is left for later. Returns notes for anything
 * left behind (empty when the role is gone). `adminUrl` is a superuser URL on
 * the same cluster; its database part is replaced per database.
 */
export async function dropScratchBypassRole(
  admin: Sql,
  adminUrl: string,
  role: string,
  options: { deadline?: number } = {},
): Promise<string[]> {
  const notes = await revokeMemberships(admin, role);
  const deadline = options.deadline ?? Date.now() + 60_000;
  try {
    const databases = await admin<{ datname: string | null; owns: boolean; reachable: boolean }[]>`
      SELECT d.datname, bool_or(s.deptype = 'o') AS owns,
             coalesce(bool_and(
               d.datallowconn AND starts_with(d.datname, 'og_')
               AND (d.datistemplate OR NOT starts_with(d.datname, 'og_test_template_'))
             ), false) AS reachable
        FROM pg_shdepend s
        JOIN pg_roles r ON r.oid = s.refobjid AND s.refclassid = 'pg_authid'::regclass
        LEFT JOIN pg_database d ON d.oid = s.dbid
       WHERE r.rolname = ${role}
       GROUP BY d.datname
       ORDER BY d.datname`;
    const owned = databases.filter((database) => database.owns);
    if (owned.length > 0) {
      notes.push(
        `${role}: owns objects in ${owned.map((database) => database.datname ?? "shared objects").join(", ")}`,
      );
      return notes;
    }
    for (const { datname, reachable } of databases) {
      if (!datname || !reachable) continue;
      if (Date.now() > deadline) {
        notes.push(`${role}: out of time before ${datname}`);
        break;
      }
      const url = new URL(adminUrl);
      url.pathname = `/${datname}`;
      const target = postgres(url.toString(), {
        max: 1,
        connect_timeout: 10,
        onnotice: () => undefined,
        connection: { lock_timeout: 2000, statement_timeout: 30_000 },
      });
      try {
        // It owns nothing here (checked above), so this only revokes.
        await target.unsafe(`DROP OWNED BY ${quoteIdent(role)}`);
      } catch (error) {
        // Dropped meanwhile: nothing left to revoke there.
        if ((error as { code?: unknown })?.code !== "3D000") {
          notes.push(`${role}: revoking in ${datname}: ${message(error)}`);
        }
      } finally {
        await target.end({ timeout: 5 }).catch(() => undefined);
      }
    }
  } catch (error) {
    notes.push(`${role}: listing its databases: ${message(error)}`);
  }
  try {
    await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
    return [];
  } catch (error) {
    notes.push(`${role}: dropping: ${message(error)}`);
    return notes;
  }
}

/** True when the role's comment is a harness owner record of a live process here. */
function ownedByLiveProcess(comment: string | null): boolean {
  const prefix = "opengeni-test-db:v1 ";
  if (!comment?.startsWith(prefix)) return false;
  try {
    const owner = JSON.parse(comment.slice(prefix.length)) as { host?: unknown; pid?: unknown };
    if (typeof owner.pid !== "number" || owner.pid <= 0) return false;
    // Another machine's owner: we cannot tell, so treat it as live.
    if (typeof owner.host === "string" && owner.host.split("#")[0] !== hostname()) return true;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { code?: unknown })?.code === "EPERM";
  }
}

/**
 * Clean up scratch bypass roles that earlier, killed runs left behind. A
 * candidate matches `pattern`, has no connection now and again after
 * `recheckMs`, carries no live owner record, and either still has a
 * membership (the part that breaks other runs) or holds nothing at all. A
 * live run holds its role's connection from its first query until its own
 * cleanup, so a role unused across the recheck is not in use. Memberships of
 * every candidate go first; the rest stops at `budgetMs`. Grant-only leftovers
 * are left alone: they no longer break anyone. Returns the roles it dropped.
 * Never throws.
 */
export async function reapStaleBypassRoles(
  admin: Sql,
  adminUrl: string,
  options: { pattern?: string; recheckMs?: number; budgetMs?: number } = {},
): Promise<string[]> {
  const pattern = options.pattern ?? SCRATCH_BYPASS_ROLE_PATTERN;
  const candidates = async () => {
    const rows = await admin<{ rolname: string; comment: string | null }[]>`
      SELECT r.rolname, shobj_description(r.oid, 'pg_authid') AS comment
        FROM pg_roles r
       WHERE r.rolname ~ ${pattern}
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usesysid = r.oid)
         AND (EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
              OR NOT EXISTS (SELECT 1 FROM pg_shdepend s
                              WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = r.oid))`;
    return new Set(
      rows.filter((row) => !ownedByLiveProcess(row.comment)).map((row) => row.rolname),
    );
  };
  const dropped: string[] = [];
  try {
    const first = await candidates();
    if (first.size === 0) return dropped;
    await Bun.sleep(options.recheckMs ?? 15_000);
    const second = await candidates();
    const stale = [...first].filter((role) => second.has(role));
    const notes: string[] = [];
    for (const role of stale) notes.push(...(await revokeMemberships(admin, role)));
    const deadline = Date.now() + (options.budgetMs ?? 45_000);
    for (const role of stale) {
      if (Date.now() > deadline) break;
      const left = await dropScratchBypassRole(admin, adminUrl, role, { deadline });
      if (left.length === 0) dropped.push(role);
      else notes.push(...left);
    }
    if (notes.length > 0) console.warn(`stale bypass role cleanup: ${notes.join("; ")}`);
  } catch (error) {
    console.warn(`stale bypass role cleanup skipped: ${String(error)}`);
  }
  return dropped;
}
