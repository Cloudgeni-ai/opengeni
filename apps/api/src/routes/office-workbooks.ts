import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  mintOfficeWorkbookTicket,
  OFFICE_WORKBOOK_WEBSOCKET_PATH,
  OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL,
  officeWorkbookRelay,
  type OfficeWorkbookOwner,
} from "../office-workbooks";
import { resolveSignedStateSecret } from "../signed-state-secret";

/** The live socket's URL on a public API base, such as "wss://app.example/v1/office/workbooks/live". */
export function officeWorkbookSocketUrl(publicBaseUrl: string): string {
  const url = new URL(OFFICE_WORKBOOK_WEBSOCKET_PATH, `${publicBaseUrl.replace(/\/+$/u, "")}/`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/** The relay shared by the socket transport, these routes and `excel_run`. */
export function officeWorkbookRelayFor(deps: Pick<ApiRouteDeps, "bus" | "settings">) {
  return officeWorkbookRelay(deps.bus, resolveSignedStateSecret(deps.settings).secret);
}

/**
 * An Office add-in connects its workbook as the signed-in person, to one
 * workspace: it asks for a short-lived ticket here (any normal API credential
 * that may run sessions there, including an embedding product's credential
 * acting for its user), then opens the live socket with it. Agents in that
 * workspace working for that person reach the workbook. An organization or
 * workspace API key acting as itself cannot connect one.
 */
export function registerOfficeWorkbookRoutes(app: Hono, deps: ApiRouteDeps): void {
  const owner = async (
    c: Parameters<typeof requireAccessGrant>[0],
    permission: "sessions:control" | "sessions:read",
  ): Promise<OfficeWorkbookOwner> => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    if (grant.subjectId.startsWith("api_key:")) {
      throw new HTTPException(403, { message: "Workbooks connect as a signed-in person" });
    }
    return { subjectId: grant.subjectId, workspaceId: grant.workspaceId };
  };

  app.post("/v1/workspaces/:workspaceId/office/workbook-tickets", async (c) => {
    c.header("cache-control", "no-store");
    const ticketOwner = await owner(c, "sessions:control");
    const relay = officeWorkbookRelayFor(deps);
    const publicBase = deps.settings.publicBaseUrl;
    return c.json({
      ...mintOfficeWorkbookTicket(relay.ticketSecret, ticketOwner),
      path: OFFICE_WORKBOOK_WEBSOCKET_PATH,
      ...(publicBase ? { url: officeWorkbookSocketUrl(publicBase) } : {}),
      protocol: OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL,
    });
  });

  // The person's open workbooks in this workspace, as their agents see them.
  app.get("/v1/workspaces/:workspaceId/office/workbooks", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      workbooks: await officeWorkbookRelayFor(deps).list(await owner(c, "sessions:read")),
    });
  });
}
