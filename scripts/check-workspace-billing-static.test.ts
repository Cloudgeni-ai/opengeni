import { describe, expect, test } from "bun:test";
import {
  checkBillingPortalSurface,
  checkForbiddenProviderImports,
  checkMcpDefaults,
  checkUnscopedOperationalRoutes,
  type Finding,
} from "./check-workspace-billing-static";

async function findingsFor(file: string, source: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  await checkForbiddenProviderImports(file, source, findings);
  return findings;
}

describe("workspace provider import guard", () => {
  test("confines the Stripe billing portal path to its API and SDK surfaces", () => {
    const portalPath = ["/v1/billing", "portal"].join("/");
    const allowed: Finding[] = [];
    checkBillingPortalSurface(
      "apps/api/src/routes/billing.ts",
      `app.post("${portalPath}")`,
      allowed,
    );
    expect(allowed).toEqual([]);

    checkBillingPortalSurface(
      "packages/sdk/src/site-browser-runtime.gen.ts",
      `const bundledClient = "${portalPath}";`,
      allowed,
    );
    expect(allowed).toEqual([]);

    checkBillingPortalSurface(
      "apps/api/src/mcp/action-catalog.gen.ts",
      `const action = { path: "${portalPath}" };`,
      allowed,
    );
    expect(allowed).toEqual([]);

    const denied: Finding[] = [];
    checkBillingPortalSurface(
      "apps/api/src/routes/example.ts",
      `app.post("${portalPath}")`,
      denied,
    );
    expect(denied).toEqual([
      {
        file: "apps/api/src/routes/example.ts",
        message: "contains Stripe billing portal route outside its canonical API/SDK surface",
      },
    ]);
  });

  test("ignores dependency names that are bundler configuration data", async () => {
    const findings = await findingsFor(
      "scripts/build-runtime-processes.ts",
      'const external = ["better-auth", "better-auth/*", "@better-auth/*", "stripe"];',
    );

    expect(findings).toEqual([]);
  });

  test.each([
    'import { betterAuth } from "better-auth";',
    'import "better-auth/plugins";',
    'const plugin = await import("@better-auth/core");',
    'const adapter = require("@better-auth/adapter");',
  ])("rejects Better Auth module edge: %s", async (source) => {
    const findings = await findingsFor("packages/core/src/example.ts", source);

    expect(findings).toEqual([
      {
        file: "packages/core/src/example.ts",
        message: "imports Better Auth outside the managed auth module",
      },
    ]);
  });

  test.each(["apps/api/src/routes/example.ts", "apps/api/src/mcp/action-catalog.gen.ts"])(
    "rejects Stripe module edges outside billing provider code: %s",
    async (file) => {
      const findings = await findingsFor(file, 'import Stripe from "stripe";');

      expect(findings).toEqual([
        {
          file,
          message: "imports Stripe outside billing route/provider code",
        },
      ]);
    },
  );

  test("retains the managed auth type-only exception", async () => {
    const findings = await findingsFor(
      "packages/core/src/managed-auth-type.ts",
      'import type { Auth } from "better-auth";',
    );

    expect(findings).toEqual([]);
  });
});

describe("workspace and organization MCP route guard", () => {
  const organizationMcpPath = ["/v1", "mcp"].join("/");
  const organizationSurfaces = [
    "apps/api/src/mcp-oauth.ts",
    "apps/api/src/organization-mcp.ts",
    "apps/api/test/organization-mcp-e2e.test.ts",
    "apps/web/src/App.tsx",
    "apps/web/src/components/organization-access/organization-connected-agents.tsx",
    "apps/web/src/dev/ui-kit/sections/page-connected-agents.tsx",
    "packages/sdk/src/client.ts",
    "packages/sdk/src/site-browser-runtime.gen.ts",
    "scripts/public-api/surface.gen.json",
  ];

  function routeFindings(file: string, source: string): Finding[] {
    const findings: Finding[] = [];
    checkUnscopedOperationalRoutes(file, source, findings);
    checkMcpDefaults(file, source, findings);
    return findings;
  }

  test.each(organizationSurfaces)(
    "admits only the canonical organization MCP leaf in %s",
    (file) => {
      expect(routeFindings(file, `const resource = "${organizationMcpPath}";`)).toEqual([]);
      expect(
        routeFindings(file, `const resource = "https://opengeni.example${organizationMcpPath}";`),
      ).toEqual([]);
      expect(routeFindings(file, `// Organization server (\`${organizationMcpPath}\`).`)).toEqual(
        [],
      );
    },
  );

  test.each(organizationSurfaces)(
    "still rejects deleted workspace MCP child paths in %s",
    (file) => {
      for (const child of ["docs", "files", "tools"]) {
        const findings = routeFindings(file, `const resource = "${organizationMcpPath}/${child}";`);
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.file === file)).toBe(true);
      }
    },
  );

  test.each([
    "apps/api/src/routes/example.ts",
    "apps/web/src/lib/mcp.ts",
    "packages/sdk/src/example.ts",
    "deploy/helm/opengeni/values.yaml",
  ])("still rejects unscoped MCP defaults outside the canonical surfaces: %s", (file) => {
    expect(routeFindings(file, `const resource = "${organizationMcpPath}";`)).toHaveLength(2);
    expect(
      routeFindings(file, `const resource = "https://opengeni.example${organizationMcpPath}";`),
    ).toHaveLength(1);
  });

  test.each([
    "sessions",
    "files",
    "document-bases",
    "scheduled-tasks",
    "github/app",
    "github/repositories",
  ])("still rejects every other deleted operational route in organization code: %s", (path) => {
    expect(routeFindings("apps/api/src/mcp-oauth.ts", `app.get("/v1/${path}");`)).toHaveLength(1);
  });

  test("does not mistake organization sign-in request routes for MCP gateway defaults", () => {
    const file = "apps/api/src/routes/example.ts";
    expect(
      routeFindings(file, `app.get("${organizationMcpPath}-connections/requests/:request");`),
    ).toEqual([]);
  });

  test("preserves scoped workspace MCP and third-party absolute URL handling", () => {
    const file = "apps/api/src/routes/example.ts";
    expect(routeFindings(file, 'const resource = "/v1/workspaces/{workspaceId}/mcp";')).toEqual([]);
    expect(
      routeFindings(file, `const resource = "https://vendor.example${organizationMcpPath}";`),
    ).toEqual([]);
  });
});
