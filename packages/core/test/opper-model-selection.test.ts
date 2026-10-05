import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";

import {
  isWorkspaceCustomModelId,
  resolveWorkspaceModelSelection,
  workspaceCustomModelReference,
} from "../src/model-catalog";

const GEMINI = "vertexai/gemini-3.8-flash-eu";

function selection(
  input: Partial<Parameters<typeof resolveWorkspaceModelSelection>[0]> = {},
  settings = testSettings({ opperApiKey: "op-deployment" }),
) {
  return resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: false,
    ...input,
  });
}

function find(rows: ReturnType<typeof selection>, id: string) {
  return rows.find((row) => row.model.id === id);
}

describe("Opper workspace model selection", () => {
  test("deployment Opper routes are credits-billed and ready with the deployment key", () => {
    const row = find(selection(), `opper/${GEMINI}`)!;
    expect(row.model.cost).toBe("credits");
    expect(row.credentialReadiness.status).toBe("ready");
    expect(row.availability.selectable).toBe(true);
  });

  test("workspace Opper routes wait for the workspace connection", () => {
    const custom = { upstreamModelId: "gemini-3.8-flash", label: "Gemini pool" };
    const waiting = selection({ workspaceOpperCustomModels: [custom] });
    for (const id of [`workspace-opper/${GEMINI}`, "workspace-opper/gemini-3.8-flash"])
      expect(find(waiting, id)).toMatchObject({
        credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
        availability: { selectable: false },
      });
    const ready = selection({
      workspaceOpperConnectionActive: true,
      workspaceOpperCustomModels: [custom],
    });
    for (const id of [`workspace-opper/${GEMINI}`, "workspace-opper/gemini-3.8-flash"])
      expect(find(ready, id)).toMatchObject({
        model: { cost: "workspace", providerId: "workspace-opper" },
        availability: { selectable: true },
      });
    // An active OpenRouter connection never readies the Opper rail.
    expect(
      find(
        selection({ workspaceOpenRouterConnectionActive: true }),
        `workspace-opper/${GEMINI}`,
      )?.availability.selectable,
    ).toBe(false);
  });

  test("organization Opper models require the organization connection", () => {
    const models = [{ upstreamModelId: "aws/claude-sonnet-4-6-eu" }];
    const id = "organization-opper/aws/claude-sonnet-4-6-eu";
    expect(
      find(selection({ organizationOpperCustomModels: models }), id)?.availability.selectable,
    ).toBe(false);
    expect(
      find(
        selection({
          organizationOpperCustomModels: models,
          organizationOpperConnectionActive: true,
        }),
        id,
      ),
    ).toMatchObject({ model: { cost: "organization" }, availability: { selectable: true } });
  });

  test("only custom Opper ids carry a mutable admission reference", () => {
    const settings = testSettings({});
    expect(isWorkspaceCustomModelId(settings, `workspace-opper/${GEMINI}`)).toBe(false);
    expect(workspaceCustomModelReference(settings, "workspace-opper/gemini-3.8-flash")).toEqual({
      scope: "workspace",
      providerKind: "opper",
      upstreamModelId: "gemini-3.8-flash",
    });
    expect(
      workspaceCustomModelReference(settings, "organization-opper/aws/claude-sonnet-4-6-eu"),
    ).toEqual({
      scope: "organization",
      providerKind: "opper",
      upstreamModelId: "aws/claude-sonnet-4-6-eu",
    });
    expect(workspaceCustomModelReference(settings, `opper/${GEMINI}`)).toBeNull();
  });
});
