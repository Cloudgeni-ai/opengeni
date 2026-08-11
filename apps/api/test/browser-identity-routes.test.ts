import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { browserIdentityRouteError } from "../src/routes/browser-identities";
import {
  BrowserIdentityConflictError,
  BrowserIdentityNotFoundError,
  BrowserIdentityStateError,
} from "@opengeni/db";

const routeUrl = new URL("../src/routes/browser-identities.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

describe("BrowserIdentity route discipline", () => {
  test("registers workspace identity discovery, creation, and immutable history", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/browser-identities"',
      '"/v1/workspaces/:workspaceId/browser-identities/:identityId"',
      '"/v1/workspaces/:workspaceId/browser-identities/:identityId/revisions"',
    ]) {
      expect(source).toContain(route);
    }
    expect(await readFile(appUrl, "utf8")).toContain(
      "registerBrowserIdentityRoutes(app, routeDeps)",
    );
  });

  test("maps absence separately from immutable-state and CAS conflicts", () => {
    expect(browserIdentityRouteError(new BrowserIdentityNotFoundError("missing")).status).toBe(404);
    expect(browserIdentityRouteError(new BrowserIdentityConflictError("conflict")).status).toBe(
      409,
    );
    expect(browserIdentityRouteError(new BrowserIdentityStateError("state")).status).toBe(409);
    expect(browserIdentityRouteError(new Error("private database detail")).message).toBe(
      "BrowserIdentity request failed",
    );
  });
});
