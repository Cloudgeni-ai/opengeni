import { AgentCallActionRequest } from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { AccessGrant } from "@opengeni/contracts";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { agentCallView, currentAgentCall, finishAgentCall } from "../agent-calls";
import { parseRequestBody } from "../http/request-body";

// The phone side of an agent's call: read it while it rings, answer, decline.
// Only the person called sees it; agents never answer for them.

async function calleeGrant(c: Context, deps: ApiRouteDeps): Promise<AccessGrant> {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  if (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.["turnId"] !== undefined ||
    grant.metadata?.["attemptId"] !== undefined
  ) {
    throw new HTTPException(403, { message: "Agents cannot answer calls" });
  }
  return grant;
}

export function registerAgentCallRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/workspaces/:workspaceId/agent-calls/:callId";
  const callId = (c: Context): string => {
    const parsed = z.string().uuid().safeParse(c.req.param("callId"));
    if (!parsed.success) throw new HTTPException(404, { message: "Call not found" });
    return parsed.data;
  };

  const load = async (c: Context, grant: AccessGrant) => {
    const call = await currentAgentCall(deps, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      callId: callId(c),
    });
    if (!call || call.calleeSubjectId !== grant.subjectId) {
      throw new HTTPException(404, { message: "Call not found" });
    }
    return call;
  };

  app.get(path, async (c) => {
    const grant = await calleeGrant(c, deps);
    const call = await load(c, grant);
    c.header("cache-control", "private, no-store");
    return c.json({ call: agentCallView(call, c.req.query("device") ?? null) });
  });

  const act = (outcome: "answered" | "declined") => async (c: Context) => {
    const grant = await calleeGrant(c, deps);
    const body = parseRequestBody(AgentCallActionRequest, await c.req.json().catch(() => ({})), {
      status: 400,
      message: "Invalid call action",
    });
    const current = await load(c, grant);
    const device = body.device ?? null;
    const settled = await finishAgentCall(deps, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      callId: current.id,
      outcome,
      calleeSubjectId: grant.subjectId,
      ...(device ? { answeredBy: device } : {}),
    });
    // Lost the race (answered elsewhere, declined, rang out): report where it stands.
    const call = settled ?? (await load(c, grant));
    c.header("cache-control", "private, no-store");
    const view = agentCallView(call, device);
    if (outcome !== "answered") return c.json({ call: view });
    // Only the phone whose answer settled the call takes it; a repeat of that
    // same answer (same device) still reads as answered here.
    const answeredHere =
      settled !== null ||
      (device !== null && call.state === "answered" && call.answeredBy === device);
    return c.json({ call: { ...view, answeredHere } });
  };

  app.post(`${path}/answer`, act("answered"));
  app.post(`${path}/decline`, act("declined"));
}
