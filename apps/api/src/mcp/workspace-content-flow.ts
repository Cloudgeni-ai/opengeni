import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  verifyCallingWorkspaceProof,
} from "@opengeni/contracts";
import {
  assertOrganizationContentFlowAllowed,
  assertWorkspaceContentExchangeAllowed,
  assertWorkspaceContentFlowAllowed,
  WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE,
  WorkspaceContentFlowRefusedError,
  workspaceContentFlowEnd,
  WorkspaceInferenceResidencyUnknownError,
  type Database,
  type WorkspaceContentFlowEnd,
} from "@opengeni/db";
import { inspectSignedState } from "@opengeni/github";
import { normalizedUrlHost, opengeniOwnHosts } from "@opengeni/runtime/calling-workspace";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/* ----------------------------------------------------------------------------
   EU-only content stays in EU-only workspaces (docs/organization-tenancy.md).

   A session reaching another workspace of its organization (session tools
   given a workspaceId, admin_action_call naming one) brings that workspace's
   content back here, and anything carrying this session's text also takes it
   there. Each call is checked for this exact pair before it runs and again
   when it returns; nothing runs, or comes back, when the check refuses or
   can't be made. A workspace of another organization isn't checked here: the
   route answers it the same as one that doesn't exist, so the answer never
   says it exists or how it is set.

   An agent of one workspace calling Opengeni's own MCP endpoints as a remote
   MCP server sends a signed header naming its workspace (the runtime adds it
   and sends nothing it can't sign). One guard on every MCP endpoint withholds
   the answer when content of the workspace or organization it reached may not
   go to that workspace.
   -------------------------------------------------------------------------- */

/**
 * `from_there`: the call only brings the other workspace's content here.
 * `both_ways`: it also carries this session's content there.
 */
export type OtherWorkspaceContentFlow = "from_there" | "both_ways";

export const REGION_RESTRICTED_TOOL_MESSAGE = `${WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE} Nothing was run. Tell the person plainly; it can't be worked around from here.`;
const UNCHECKED =
  "Nothing was run: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
/** After the call ran: its answer is withheld instead. */
const REGION_RESTRICTED_AFTER = `${WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE} The answer isn't shown. Tell the person plainly; it can't be worked around from here.`;
const UNCHECKED_AFTER =
  "The answer isn't shown: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The tool answer for a failed check, before the call (nothing ran) or after
 * it (its answer is withheld): a refusal, or a retryable unknown.
 */
export function contentFlowCheckFailure(
  error: unknown,
  phase: "before" | "after" = "before",
): CallToolResult {
  const refused = error instanceof WorkspaceContentFlowRefusedError;
  if (phase === "after") return refusal(refused ? REGION_RESTRICTED_AFTER : UNCHECKED_AFTER);
  return refusal(refused ? REGION_RESTRICTED_TOOL_MESSAGE : UNCHECKED);
}

/** Null when the call may run; otherwise the refusal to return instead. */
export async function otherWorkspaceContentRefusal(
  db: Database,
  input: {
    here: WorkspaceContentFlowEnd;
    thereWorkspaceId: string;
    flow: OtherWorkspaceContentFlow;
  },
  phase: "before" | "after" = "before",
): Promise<CallToolResult | null> {
  // Not a workspace id, or this one: the route answers as it always has.
  if (!UUID.test(input.thereWorkspaceId)) return null;
  if (input.thereWorkspaceId.toLowerCase() === input.here.workspaceId.toLowerCase()) return null;
  try {
    const there = await workspaceContentFlowEnd(db, input.thereWorkspaceId.toLowerCase());
    // No such workspace, or another organization's: the route answers that
    // this person can't reach it, exactly as it always has.
    if (!there || there.accountId !== input.here.accountId) return null;
    if (input.flow === "both_ways") {
      await assertWorkspaceContentExchangeAllowed(db, { here: input.here, there });
    } else {
      await assertWorkspaceContentFlowAllowed(db, { source: there, target: input.here });
    }
    return null;
  } catch (error) {
    return contentFlowCheckFailure(error, phase);
  }
}

/**
 * Run a call that reaches another workspace: checked before it runs and
 * again when it returns (a wait can outlast a setting change), so nothing
 * comes back once the check refuses.
 */
export async function withOtherWorkspaceContentFlow(
  db: Database,
  input: {
    here: WorkspaceContentFlowEnd;
    thereWorkspaceId: string;
    flow: OtherWorkspaceContentFlow;
  },
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const before = await otherWorkspaceContentRefusal(db, input);
  if (before) return before;
  const result = await run();
  return (await otherWorkspaceContentRefusal(db, input, "after")) ?? result;
}

const ORGANIZATION_MCP_ENDPOINT = /^\/v1\/mcp\/?$/;
const WORKSPACE_MCP_ENDPOINT = /^\/v1\/workspaces\/([^/]+)\/mcp(?:\/|$)/;
const UNCHECKED_ENDPOINT =
  "Nothing was shown: Opengeni couldn't confirm that content may go to the calling workspace. Retry.";

/** What an Opengeni MCP endpoint reaches: one workspace, or every workspace of an organization. */
export type McpEndpointReach = { workspaceId: string } | { accountId: string };

/** Which organization `/v1/mcp` served, noted by its handler once the caller is authorized. */
const organizationMcpReach = new WeakMap<Request, string>();

export function noteOrganizationMcpReach(request: Request, accountId: string): void {
  organizationMcpReach.set(request, accountId);
}

/**
 * The Opengeni workspace calling, from its signed header: null when the
 * request names none (it doesn't come from a workspace agent); 403 when the
 * proof isn't one Opengeni signed. Reveals nothing about what it reaches.
 */
export async function callingWorkspaceOf(
  settings: Settings,
  request: Request,
): Promise<WorkspaceContentFlowEnd | null> {
  const header = request.headers.get(OPENGENI_CALLING_WORKSPACE_HEADER);
  if (header === null) return null;
  const secret = resolveFirstPartyDelegationSecret(settings);
  const calling = secret ? await verifyCallingWorkspaceProof(secret, header) : null;
  if (!calling)
    throw new HTTPException(403, {
      message: "Nothing was run: Opengeni couldn't confirm which workspace is calling.",
    });
  return calling;
}

/** Refuse unless content of what an MCP endpoint reached may go to the calling workspace. */
export async function assertCallingWorkspaceMayReceive(
  db: Database,
  reached: McpEndpointReach,
  calling: WorkspaceContentFlowEnd,
): Promise<void> {
  if ("accountId" in reached) {
    await assertOrganizationContentFlowAllowed(db, {
      sourceAccountId: reached.accountId,
      target: calling,
    });
    return;
  }
  const source = await workspaceContentFlowEnd(db, reached.workspaceId);
  if (!source) throw new WorkspaceInferenceResidencyUnknownError();
  await assertWorkspaceContentFlowAllowed(db, { source, target: calling });
}

/**
 * One guard on every Opengeni MCP endpoint (`/v1/mcp` and everything under
 * `/v1/workspaces/:workspaceId/mcp`), so a new endpoint can't miss it. A
 * request naming the Opengeni workspace calling (the runtime adds the header
 * when a workspace agent calls Opengeni itself as a remote MCP server) gets an
 * answer only when content of what it reached may go to that workspace.
 *
 * The check runs on the endpoint's answer, after the endpoint authorized the
 * caller, so a refusal says nothing to anyone who can't already reach it.
 * Content only leaves through that answer: whatever the call sent in is
 * content of the calling workspace, which may go anywhere unless that
 * workspace is EU-only, and then the reached one must be too for the answer.
 * A failed check withholds the answer.
 */
export function callingWorkspaceContentFlowGuard(deps: {
  db: Database;
  settings: Settings;
}): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const workspaceMatch = WORKSPACE_MCP_ENDPOINT.exec(path);
    if (!workspaceMatch && !ORGANIZATION_MCP_ENDPOINT.test(path)) return await next();
    const calling = await callingWorkspaceOf(deps.settings, c.req.raw);
    if (!calling) return await next();
    await next();
    if (c.res.status >= 400) return;
    try {
      let reached: McpEndpointReach;
      if (workspaceMatch) {
        reached = { workspaceId: decodeURIComponent(workspaceMatch[1]!).toLowerCase() };
        if (!UUID.test(reached.workspaceId)) throw new WorkspaceInferenceResidencyUnknownError();
      } else {
        const accountId = organizationMcpReach.get(c.req.raw);
        if (!accountId) throw new WorkspaceInferenceResidencyUnknownError();
        reached = { accountId };
      }
      await assertCallingWorkspaceMayReceive(deps.db, reached, calling);
    } catch (error) {
      // Drop the answer, and its own headers, before the error answers.
      await c.res.body?.cancel().catch(() => undefined);
      try {
        for (const name of [...c.res.headers.keys()])
          if (name !== "set-cookie") c.res.headers.delete(name);
      } catch {
        // Immutable headers: the error answer still replaces the body.
      }
      c.res = new Response(null, { status: 500 });
      if (error instanceof WorkspaceContentFlowRefusedError) throw error;
      throw new HTTPException(503, { message: UNCHECKED_ENDPOINT, cause: error });
    }
  };
}

const INTEGRATION_OAUTH_CALLBACK_PATH = "/v1/integrations/oauth/callback";

/**
 * The Opengeni workspace asking for an MCP OAuth grant to Opengeni itself, or
 * null for a client outside Opengeni. Opengeni's own client sends this
 * deployment's signed integration state, which names the workspace; a
 * request back to Opengeni's own integration callback whose state doesn't
 * name one throws, so consent can't go ahead unchecked.
 */
export function oauthRequestingWorkspace(
  settings: Settings,
  request: { redirectUri: string; state: string | null },
  requestUrl: string,
): WorkspaceContentFlowEnd | null {
  const secret = settings.integrationsStateSecret?.trim();
  const state = secret && request.state ? inspectSignedState(request.state, secret) : null;
  if (state) {
    const { accountId, workspaceId } = state as { accountId?: unknown; workspaceId?: unknown };
    if (
      typeof accountId === "string" &&
      typeof workspaceId === "string" &&
      UUID.test(accountId) &&
      UUID.test(workspaceId)
    )
      return { accountId: accountId.toLowerCase(), workspaceId: workspaceId.toLowerCase() };
    throw new WorkspaceInferenceResidencyUnknownError();
  }
  let redirect: URL;
  try {
    redirect = new URL(request.redirectUri);
  } catch {
    return null;
  }
  const ownHosts = opengeniOwnHosts(settings);
  const requestHost = normalizedUrlHost(requestUrl);
  if (requestHost) ownHosts.add(requestHost);
  const host = normalizedUrlHost(request.redirectUri);
  const path = decodeURIComponent(redirect.pathname).replace(/\/+$/, "");
  if (host && ownHosts.has(host) && path === INTEGRATION_OAUTH_CALLBACK_PATH)
    throw new WorkspaceInferenceResidencyUnknownError();
  return null;
}

/**
 * At MCP OAuth consent: refuse a grant to Opengeni's own client in a workspace
 * that EU-only content of what the grant reaches may not go to. Outside
 * clients the organization connects stay allowed.
 */
export async function assertOAuthConsentContentFlowAllowed(
  deps: { db: Database; settings: Settings },
  input: {
    request: { redirectUri: string; state: string | null };
    requestUrl: string;
    reached: McpEndpointReach;
  },
): Promise<void> {
  const requesting = oauthRequestingWorkspace(deps.settings, input.request, input.requestUrl);
  if (!requesting) return;
  await assertCallingWorkspaceMayReceive(deps.db, input.reached, requesting);
}
