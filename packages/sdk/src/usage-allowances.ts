// @opengeni/sdk/usage-allowances — usage allowance reads and administration as
// free functions over any client's `requestJson`, so a browser console can use
// them without widening the native browser client. The root `OpenGeniClient`
// methods of the same names call the same routes.
//
// Amounts are integer USD micros (1 USD = 1,000,000). Display `fraction` and
// `status` in products that must not show money; see docs/usage-allowances.md.
import type { OpenGeniClient, OpenGeniRequestOptions } from "./client";
import type {
  ClearWorkspaceAllowanceRequest,
  ClearWorkspaceAllowanceResponse,
  GetMyUsageRequest,
  GetUsageRequest,
  GrantWorkspaceCreditsRequest,
  MemberAllowance,
  SetMemberAllowanceRequest,
  SetWorkspaceAllowanceRequest,
  WorkspaceAllowance,
  WorkspaceAllowanceState,
  WorkspaceCreditGrant,
  WorkspaceUsageResponse,
} from "@opengeni/contracts/usage-allowances";

export type {
  AllowanceExhaustedRefusal,
  ClearWorkspaceAllowanceRequest,
  ClearWorkspaceAllowanceResponse,
  GetMyUsageRequest,
  GetUsageRequest,
  GrantWorkspaceCreditsRequest,
  MemberAllowance,
  MemberAllowanceDefault,
  MemberAllowanceRule,
  MemberAllowanceUsage,
  SetMemberAllowanceRequest,
  SetWorkspaceAllowanceRequest,
  UsageAllowancePeriod,
  UsageAllowanceStatus,
  UsageAllowanceWindow,
  WorkspaceAllowance,
  WorkspaceAllowanceConfig,
  WorkspaceAllowanceState,
  WorkspaceAllowanceUsage,
  WorkspaceCreditGrant,
  WorkspaceUsageResponse,
} from "@opengeni/contracts/usage-allowances";

/** The one client capability these functions need. */
export type UsageAllowanceRequestClient = Pick<OpenGeniClient, "requestJson">;

/** A member target: canonical subject id, or an external identity. */
export type UsageAllowanceMemberTarget = string | { source: string; externalId: string };

function workspacePath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Query strings for usage reads: only defined values, stringified. */
export function usageAllowanceQuery(query: GetUsageRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

/** Configuration, or null when no ceiling is configured. Budget-read authority. */
export async function getWorkspaceAllowance(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
): Promise<WorkspaceAllowance | null> {
  return await client.requestJson("GET", `${workspacePath(workspaceId)}/allowance`);
}

/** Lifecycle version plus configuration; version survives a clear. Budget-read authority. */
export async function getWorkspaceAllowanceState(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
): Promise<WorkspaceAllowanceState> {
  return await client.requestJson("GET", `${workspacePath(workspaceId)}/allowance/state`);
}

/**
 * Set the workspace ceiling with exact-version compare-and-set. Requires a
 * verified organization administrator or a full-access organization key.
 */
export async function setWorkspaceAllowance(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  request: SetWorkspaceAllowanceRequest,
): Promise<WorkspaceAllowance> {
  return await client.requestJson("PUT", `${workspacePath(workspaceId)}/allowance`, request);
}

/** Remove the ceiling (not a refund or counter reset). Returns the next lifecycle version. */
export async function clearWorkspaceAllowance(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  request: ClearWorkspaceAllowanceRequest,
): Promise<ClearWorkspaceAllowanceResponse> {
  return await client.requestJson("DELETE", `${workspacePath(workspaceId)}/allowance`, request);
}

/** One-off credits on top of the included amount. Reuse the operationId to retry. */
export async function grantWorkspaceCredits(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  request: GrantWorkspaceCreditsRequest,
): Promise<WorkspaceCreditGrant> {
  return await client.requestJson(
    "POST",
    `${workspacePath(workspaceId)}/allowance/grants`,
    request,
  );
}

/**
 * Set or restore (`rule: null`) one member's ceiling with exact-version CAS.
 * Shares may oversubscribe the pool; the workspace ceiling still binds.
 */
export async function setMemberAllowance(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  member: UsageAllowanceMemberTarget,
  request: SetMemberAllowanceRequest,
): Promise<MemberAllowance> {
  const path =
    typeof member === "string"
      ? encodeURIComponent(member)
      : `external/${encodeURIComponent(member.source)}/${encodeURIComponent(member.externalId)}`;
  return await client.requestJson(
    "PUT",
    `${workspacePath(workspaceId)}/members/${path}/allowance`,
    request,
  );
}

/** The paginated roster page. Workspace admin, organization admin, or org-key read. */
export async function getUsage(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  query: GetUsageRequest = {},
  options: OpenGeniRequestOptions = {},
): Promise<WorkspaceUsageResponse> {
  return await client.requestJson(
    "GET",
    `${workspacePath(workspaceId)}/usage`,
    undefined,
    usageAllowanceQuery(query),
    options,
  );
}

/** The caller's own row plus the workspace aggregate. Any authenticated member. */
export async function getMyUsage(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  query: GetMyUsageRequest = {},
  options: OpenGeniRequestOptions = {},
): Promise<WorkspaceUsageResponse> {
  return await client.requestJson(
    "GET",
    `${workspacePath(workspaceId)}/usage/me`,
    undefined,
    usageAllowanceQuery(query),
    options,
  );
}

/** Every roster page for one period (follows `nextCursor`). */
export async function getAllUsage(
  client: UsageAllowanceRequestClient,
  workspaceId: string,
  query: Omit<GetUsageRequest, "cursor"> = {},
  options: OpenGeniRequestOptions = {},
): Promise<WorkspaceUsageResponse> {
  const first = await getUsage(client, workspaceId, { limit: 200, ...query }, options);
  const members = [...first.members];
  let cursor = first.nextCursor;
  // Bounded: a cursor that repeats would otherwise loop forever.
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const page = await getUsage(client, workspaceId, { limit: 200, ...query, cursor }, options);
    members.push(...page.members);
    cursor = page.nextCursor;
  }
  return { ...first, members, nextCursor: null };
}
