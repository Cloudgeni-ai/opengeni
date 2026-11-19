/**
 * Runs on (Console agents, docs/agents.md "Runs on"): the organization
 * machines and sandbox environments (rigs) an organization agent can name.
 *
 * Organization machines and rigs live in the workspace they were connected
 * from or made in, so an account-level caller (Console, an organization key,
 * a code deploy) cannot read their rows directly. The listing uses
 * `list_organization_compute_v1` (1224), which lists every active
 * organization machine or rig of the account wherever it works, read as the
 * system (no session actor) from one of the account's shared workspaces.
 * Personal (Only me) and workspace machines are never listed, so they can
 * never be named. Callers check `agents:read` / `agents:manage` or
 * organization administration first: this is not authorization.
 */
import type { OrganizationComputeReach, OrgAgentRunsOn } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, withoutSessionRlsActor, withRlsContext, type Database } from "./database";

export type OrgComputeKind = "machine" | "rig";

/** One organization machine (enrollment id, with its sandbox) or rig. */
export type OrgComputeEntry = {
  id: string;
  sandboxId: string | null;
  name: string;
  reach: OrganizationComputeReach;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every active organization machine or rig of the account. `tx` is in the
 * account's RLS context (no workspace); the read runs in a nested scope of
 * one shared workspace and restores the caller's scope. Empty when the
 * account has no shared workspace.
 */
export async function listOrganizationComputeInAccount(
  tx: Database,
  accountId: string,
  kind: OrgComputeKind,
): Promise<OrgComputeEntry[]> {
  const [anchor] = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id::text as workspace_id
      from list_organization_workspace_ids(${accountId}::uuid)
      order by workspace_id limit 1`,
  );
  if (!anchor) return [];
  const rows = await withoutSessionRlsActor(() =>
    withRlsContext(tx, { accountId, workspaceId: anchor.workspace_id }, (scoped) =>
      rawRows<{
        value: {
          id: string;
          name?: string | null;
          sandboxId?: string | null;
          sandboxName?: string | null;
          os?: string | null;
          reach: OrganizationComputeReach;
        };
      }>(
        scoped,
        sql`select value from opengeni_private.list_organization_compute_v1(
          ${accountId}::uuid, ${anchor.workspace_id}::uuid, ${kind}
        ) value`,
      ),
    ),
  );
  return rows.map(({ value }) => ({
    id: value.id,
    sandboxId: value.sandboxId ?? null,
    // As the machine list names a machine.
    name: kind === "machine" ? (value.sandboxName ?? `${value.os} machine`) : (value.name ?? ""),
    reach: { ...value.reach, allowManagedWorkspaces: value.reach.allowManagedWorkspaces ?? false },
  }));
}

/** Whether a reach includes every workspace the organization's product manages. */
export function computeReachIncludesManagedWorkspaces(reach: OrganizationComputeReach): boolean {
  return reach.allowedWorkspaceIds === null || reach.allowManagedWorkspaces === true;
}

/** The organization machines and sandbox environments, for the Console "Runs on" control. */
export async function listOrgAgentCompute(
  db: Database,
  accountId: string,
): Promise<{ machines: OrgComputeEntry[]; environments: OrgComputeEntry[] }> {
  return await withAccountRls(db, accountId, async (tx) => ({
    machines: await listOrganizationComputeInAccount(tx, accountId, "machine"),
    environments: await listOrganizationComputeInAccount(tx, accountId, "rig"),
  }));
}

export type OrgComputeMatch =
  | { status: "found"; entry: OrgComputeEntry }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number };

/**
 * The entry a `runsOn` reference names: an id (a machine's enrollment or
 * sandbox id, a rig's id), else a name (case-insensitive). A name that
 * several share is ambiguous: name it by id.
 */
export function findOrgCompute(entries: readonly OrgComputeEntry[], ref: string): OrgComputeMatch {
  const wanted = ref.trim();
  if (UUID_PATTERN.test(wanted)) {
    const id = wanted.toLowerCase();
    const entry = entries.find(
      (candidate) => candidate.id.toLowerCase() === id || candidate.sandboxId?.toLowerCase() === id,
    );
    if (entry) return { status: "found", entry };
  }
  const key = wanted.toLowerCase();
  const named = entries.filter((candidate) => candidate.name.trim().toLowerCase() === key);
  if (named.length === 1) return { status: "found", entry: named[0]! };
  if (named.length > 1) return { status: "ambiguous", count: named.length };
  return { status: "not_found" };
}

export type OrgAgentRunsOnProblem = {
  code: "machine_not_found" | "environment_not_found";
  message: string;
};

/** Why a `runsOn` names nothing usable, or null. `tx` is in the account's RLS context. */
export async function orgAgentRunsOnProblem(
  tx: Database,
  accountId: string,
  runsOn: OrgAgentRunsOn | undefined,
): Promise<OrgAgentRunsOnProblem | null> {
  if (!runsOn) return null;
  if (runsOn.kind === "machine" && runsOn.machine !== undefined) {
    const match = findOrgCompute(
      await listOrganizationComputeInAccount(tx, accountId, "machine"),
      runsOn.machine,
    );
    if (match.status === "found") return null;
    return {
      code: "machine_not_found",
      message:
        match.status === "ambiguous"
          ? `${match.count} organization machines are named '${runsOn.machine}'. Name the machine by its id.`
          : `'${runsOn.machine}' is not an organization machine of this organization. Organization agents run only on organization machines, never on Personal (Only me) or workspace machines.`,
    };
  }
  if (runsOn.kind === "sandbox" && runsOn.environment !== undefined) {
    const match = findOrgCompute(
      await listOrganizationComputeInAccount(tx, accountId, "rig"),
      runsOn.environment,
    );
    if (match.status === "found") return null;
    return {
      code: "environment_not_found",
      message:
        match.status === "ambiguous"
          ? `${match.count} organization sandbox environments are named '${runsOn.environment}'. Name it by its id.`
          : `'${runsOn.environment}' is not an organization sandbox environment of this organization. Organization agents use only organization sandbox environments.`,
    };
  }
  return null;
}

/** {@link orgAgentRunsOnProblem} in its own account-scoped transaction. */
export async function checkOrgAgentRunsOn(
  db: Database,
  accountId: string,
  runsOn: OrgAgentRunsOn | undefined,
): Promise<OrgAgentRunsOnProblem | null> {
  if (!runsOn || (runsOn.machine === undefined && runsOn.environment === undefined)) return null;
  return await withAccountRls(db, accountId, (tx) => orgAgentRunsOnProblem(tx, accountId, runsOn));
}
