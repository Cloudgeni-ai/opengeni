import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(resolve(here, "..", "src", "routes", "insights.ts"), "utf8");
const appSrc = readFileSync(resolve(here, "..", "src", "app.ts"), "utf8");

describe("insights route discipline", () => {
  test("requires workspace:admin before aggregating", () => {
    const grantCall = 'requireAccessGrant(c, deps, workspaceId, "workspace:admin")';
    const grantAt = routesSrc.indexOf(grantCall);
    expect(grantAt).toBeGreaterThanOrEqual(0);
    const getAt = routesSrc.indexOf("await getWorkspaceInsights(", grantAt);
    expect(getAt).toBeGreaterThan(grantAt);
  });

  test("is registered on the API app and access-key catalog", () => {
    expect(appSrc).toContain("registerInsightsRoutes(app, routeDeps)");
    expect(appSrc).toContain('label: "/v1/workspaces/:workspaceId/insights"');
  });

  test("does not accept sessions:read as sufficient", () => {
    expect(routesSrc.includes('"sessions:read"')).toBe(false);
    expect(routesSrc.includes('"workspace:read"')).toBe(false);
  });
});
