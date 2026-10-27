import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  verifyCallingWorkspaceProof,
} from "@opengeni/contracts";
import {
  assertOrganizationContentExchangeAllowed,
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
import { boundedMcpRequest } from "@opengeni/runtime/mcp-network";
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
   and sends nothing it can't sign). Each MCP endpoint refuses a call beyond
   the handshake before it runs unless content may move both ways, and one
   guard on every MCP endpoint withholds any answer whose content may not go
   to that workspace.
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
const UNCHECKED_CALL =
  "Nothing was run: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
/** MCP methods that only set up the connection or list what it offers. */
const HANDSHAKE_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

/** What an Opengeni MCP endpoint reaches: one workspace, or every workspace of an organization. */
export type McpEndpointReach = { workspaceId: string } | { accountId: string };

/** A request naming the Opengeni workspace calling, as the guard and the endpoint see it. */
type CallingWorkspaceRequest = {
  calling: WorkspaceContentFlowEnd;
  /** Anything beyond the handshake, which may carry the caller's content in or change things. */
  carriesContent: boolean;
  /** What the endpoint authorized, recorded right after it did. */
  reached?: McpEndpointReach;
  exchangeChecked?: boolean;
};
const callingWorkspaceRequests = new WeakMap<Request, CallingWorkspaceRequest>();

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

/** Whether a JSON-RPC request asks for more than the handshake; unreadable counts as more. */
async function carriesContent(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  let messages: unknown;
  try {
    messages = JSON.parse(await (await boundedMcpRequest(request.clone())).text());
  } catch {
    return true;
  }
  const list = Array.isArray(messages) ? messages : [messages];
  return list.some((message) => {
    const method = (message as { method?: unknown } | null)?.method;
    // A response or notification sent to the server carries no request.
    if (method === undefined && message !== null && typeof message === "object") return false;
    if (typeof method !== "string") return true;
    return !HANDSHAKE_METHODS.has(method) && !method.startsWith("notifications/");
  });
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

/** Refuse unless content may move both ways between what was reached and the calling workspace. */
export async function assertCallingWorkspaceExchangeAllowed(
  db: Database,
  reached: McpEndpointReach,
  calling: WorkspaceContentFlowEnd,
): Promise<void> {
  if ("accountId" in reached) {
    await assertOrganizationContentExchangeAllowed(db, {
      accountId: reached.accountId,
      here: calling,
    });
    return;
  }
  const there = await workspaceContentFlowEnd(db, reached.workspaceId);
  if (!there) throw new WorkspaceInferenceResidencyUnknownError();
  await assertWorkspaceContentExchangeAllowed(db, { here: calling, there });
}

/**
 * Every Opengeni MCP endpoint calls this right after it authorized the caller,
 * with the workspace or organization that authorization reaches, and before
 * it runs anything. For a request naming the Opengeni workspace calling, a
 * call beyond the handshake (a tool call, a read) is refused before it runs
 * unless content may move both ways: it can carry the caller's content in or
 * change things there, and its answer brings content back. A refusal here
 * comes after authorization, so it says nothing to anyone who can't already
 * reach it.
 */
export async function requireCallingWorkspaceContentExchange(
  db: Database,
  request: Request,
  reached: McpEndpointReach,
): Promise<void> {
  const state = callingWorkspaceRequests.get(request);
  if (!state) return;
  state.reached = reached;
  if (!state.carriesContent) return;
  try {
    await assertCallingWorkspaceExchangeAllowed(db, reached, state.calling);
  } catch (error) {
    if (error instanceof WorkspaceContentFlowRefusedError) throw error;
    throw new HTTPException(503, { message: UNCHECKED_CALL, cause: error });
  }
  state.exchangeChecked = true;
}

/**
 * One guard on every Opengeni MCP endpoint (`/v1/mcp` and everything under
 * `/v1/workspaces/:workspaceId/mcp`), so a new endpoint can't slip past it.
 * For a request naming the Opengeni workspace calling (the runtime adds the
 * header when a workspace agent calls Opengeni itself as a remote MCP server):
 *
 * - the proof is verified first (403, nothing runs);
 * - the endpoint refuses a call beyond the handshake before it runs unless
 *   content may move both ways (`requireCallingWorkspaceContentExchange`);
 * - the answer is withheld unless content of what was reached may go to the
 *   calling workspace, and when the endpoint didn't record what it reached or
 *   didn't check a call that carries content. A failed check withholds it too.
 */
export function callingWorkspaceContentFlowGuard(deps: {
  db: Database;
  settings: Settings;
}): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!WORKSPACE_MCP_ENDPOINT.test(path) && !ORGANIZATION_MCP_ENDPOINT.test(path))
      return await next();
    const calling = await callingWorkspaceOf(deps.settings, c.req.raw);
    if (!calling) return await next();
    const state: CallingWorkspaceRequest = {
      calling,
      carriesContent: await carriesContent(c.req.raw),
    };
    callingWorkspaceRequests.set(c.req.raw, state);
    await next();
    if (c.res.status >= 400) return;
    try {
      if (!state.reached || (state.carriesContent && !state.exchangeChecked))
        throw new WorkspaceInferenceResidencyUnknownError();
      await assertCallingWorkspaceMayReceive(deps.db, state.reached, calling);
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
 * unless content may move both ways between it and what the grant reaches.
 * Outside clients the organization connects stay allowed.
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
  // The grant lets that workspace's agent read and change what it reaches.
  await assertCallingWorkspaceExchangeAllowed(deps.db, input.reached, requesting);
}
