import { expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import {
  integrationAvailable,
  requireIntegrationAvailable,
} from "../src/integrations/teams-rollout";

const workspace = "b2a93667-d2ce-4468-8b65-3c773b701ad7";
const other = "d238469d-252e-4ab1-b6af-65342fc802be";

test("Teams defaults off without changing existing Microsoft connectors", () => {
  const settings = getSettings({});
  expect(settings.teamsBotEnabled).toBe(false);
  expect(settings.teamsBotAllowedTenantIds).toEqual([]);
  expect(integrationAvailable(settings, workspace, "microsoft-teams")).toBe(false);
  expect(() => requireIntegrationAvailable(settings, workspace, "microsoft-teams")).toThrow(
    "not available",
  );
  expect(integrationAvailable(settings, workspace, "microsoft-outlook-mail")).toBe(true);
});

test("private reviewer workspace does not enable Teams for another workspace", () => {
  const settings = getSettings({
    OPENGENI_MICROSOFT_TEAMS_ALLOWED_WORKSPACE_IDS: ` ${workspace} `,
  });
  expect(settings.microsoftTeamsToolsEnabled).toBe(false);
  expect(integrationAvailable(settings, workspace, "microsoft-teams")).toBe(true);
  expect(integrationAvailable(settings, other, "microsoft-teams")).toBe(false);
  expect(settings.teamsBotAllowedTenantIds).toEqual([]);
});

test("explicit global rollout enables tools, while malformed allowlists fail startup", () => {
  expect(
    integrationAvailable(
      getSettings({ OPENGENI_MICROSOFT_TEAMS_TOOLS_ENABLED: "true" }),
      other,
      "microsoft-teams",
    ),
  ).toBe(true);
  expect(() => getSettings({ OPENGENI_TEAMS_BOT_ALLOWED_TENANT_IDS: "*" })).toThrow();
  expect(() => getSettings({ OPENGENI_MICROSOFT_TEAMS_ALLOWED_WORKSPACE_IDS: "all" })).toThrow();
});

test("disabled Teams OAuth and source preview stop before storage or provider access", async () => {
  const { startApiIntegrationProviderOAuth } = await import("../src/integrations/provider-oauth");
  const { resolveForRoute } = await import("../src/routes/api-integrations");
  const deps = new Proxy(
    { settings: getSettings({}) },
    {
      get(target, key) {
        if (key === "settings") return target.settings;
        throw new Error(`Unexpected dependency access: ${String(key)}`);
      },
    },
  ) as Parameters<typeof startApiIntegrationProviderOAuth>[0];
  await expect(
    startApiIntegrationProviderOAuth(deps, {
      accountId: "account",
      workspaceId: workspace,
      subjectId: "human",
      personalOwnershipAllowed: true,
      requestUrl: "https://app.example.test",
      payload: { definitionId: "microsoft-teams", ownership: "personal" },
    }),
  ).rejects.toThrow("Integration is not available");
  await expect(
    resolveForRoute({
      deps,
      accountId: "account",
      workspaceId: workspace,
      subjectId: "human",
      transport: {
        fetch: async () => {
          throw new Error("Unexpected provider request");
        },
      },
      payload: { source: { kind: "definition", definitionId: "microsoft-teams" } },
    }),
  ).rejects.toThrow("Integration is not available");
});
