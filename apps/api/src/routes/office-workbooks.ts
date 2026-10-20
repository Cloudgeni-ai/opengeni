import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  mintOfficeWorkbookTicket,
  OFFICE_WORKBOOK_WEBSOCKET_PATH,
  OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL,
  officeWorkbookRelay,
} from "../office-workbooks";
import { resolveSignedStateSecret } from "../signed-state-secret";

/** The relay shared by the socket transport, these routes and `excel_run`. */
export function officeWorkbookRelayFor(deps: Pick<ApiRouteDeps, "bus" | "settings">) {
  return officeWorkbookRelay(deps.bus, resolveSignedStateSecret(deps.settings).secret);
}

/**
 * The Office add-in connects its workbook as the signed-in person: it asks for
 * a short-lived ticket here (any normal API credential), then opens the live
 * socket with it. Only people connect workbooks; keys and services cannot.
 */
export function registerOfficeWorkbookRoutes(app: Hono, deps: ApiRouteDeps): void {
  const person = async (c: Parameters<typeof requireAccessContext>[0]) => {
    const context = await requireAccessContext(c, deps);
    if (context.subjectId.startsWith("api_key:")) {
      throw new HTTPException(403, { message: "Workbooks connect as a signed-in person" });
    }
    return context.subjectId;
  };

  app.post("/v1/office/workbook-tickets", async (c) => {
    c.header("cache-control", "no-store");
    const subjectId = await person(c);
    const relay = officeWorkbookRelayFor(deps);
    return c.json({
      ...mintOfficeWorkbookTicket(relay.ticketSecret, subjectId),
      path: OFFICE_WORKBOOK_WEBSOCKET_PATH,
      protocol: OFFICE_WORKBOOK_WEBSOCKET_PROTOCOL,
    });
  });

  // The person's open workbooks, as their agents see them.
  app.get("/v1/office/workbooks", async (c) => {
    c.header("cache-control", "no-store");
    const subjectId = await person(c);
    return c.json({ workbooks: await officeWorkbookRelayFor(deps).list(subjectId) });
  });
}
