import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { assertGoogleConnectorSetupEnabled } from "../src/integrations/google-connector-availability";
import { startMcpOAuth } from "../src/integrations/oauth-client";
import { applyGoogleConnectorSetupAvailability } from "@opengeni/core";

test("disabled setup rejects Gmail and Drive before database or Google requests", async () => {
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected database access");
      },
    },
  );
  const settings = testSettings({
    integrationsEnabled: true,
    googleConnectorSetupEnabled: false,
    googleDriveMcpEnabled: true,
  });
  for (const host of ["gmailmcp.googleapis.com", "drivemcp.googleapis.com"]) {
    await expect(
      startMcpOAuth(
        { db: database, settings } as any,
        {
          accountId: "account",
          workspaceId: "workspace",
          subjectId: "human",
          personalOwnershipAllowed: true,
          requestUrl: "https://app.example.test",
          payload: { mcpUrl: `https://${host}/mcp/v1`, ownership: "personal" },
        } as any,
      ),
    ).rejects.toThrow("temporarily unavailable");
  }
});
test("official Drive remains preview-gated independently of Gmail", async () => {
  const settings = testSettings({ integrationsEnabled: true });
  expect(() => assertGoogleConnectorSetupEnabled(settings)).not.toThrow();
  await expect(
    startMcpOAuth(
      { settings, db: {} } as any,
      {
        accountId: "account",
        workspaceId: "workspace",
        subjectId: "human",
        personalOwnershipAllowed: true,
        requestUrl: "https://app.example.test",
        payload: { mcpUrl: "https://drivemcp.googleapis.com/mcp/v1", ownership: "personal" },
      } as any,
    ),
  ).rejects.toThrow("preview");
});
test("catalog gate preserves installed connections while withholding setup readiness", () => {
  const settings = testSettings({ googleConnectorSetupEnabled: false });
  const item = {
    kind: "mcp",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    enabled: true,
    runtime: { available: true },
  } as any;
  const gated = applyGoogleConnectorSetupAvailability(item, settings);
  expect(gated.enabled).toBe(true);
  expect(gated.runtime?.available).toBe(true);
  expect(gated.runtime?.operatorOAuthClient?.configured).toBe(false);
  const other = { ...item, mcpUrl: "https://other.example/mcp" };
  expect(applyGoogleConnectorSetupAvailability(other, settings)).toBe(other);
});
