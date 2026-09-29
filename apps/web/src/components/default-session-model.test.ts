import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { projectPickerRows } from "@/lib/model-policy";

import { defaultModelPickerRows, defaultModelSummary } from "./default-session-model";

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    provider: "opengeni",
    providerLabel: "OpenGeni",
    api: "responses",
    cost: "credits",
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    policyAllowed: true,
    availability: { status: "available", selectable: true, reason: null, checkedAt: null },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

const creditsDefault = catalogModel({
  id: "gpt-6-astra",
  label: "GPT-6 Astra",
  credentialReadiness: {
    status: "not_ready",
    reason: "missing_credential",
    basis: "configuration",
    checkedAt: null,
  },
  availability: {
    status: "unavailable",
    selectable: false,
    reason: "missing_credential",
    checkedAt: null,
  },
});
const codex = catalogModel({
  id: "codex/gpt-6-astra",
  label: "GPT-6 Astra",
  provider: "codex",
  providerLabel: "Codex",
  source: "codex",
  cost: "subscription",
  billing: { upstreamPayer: "connected_subscription", metering: "external" },
});

describe("default model row", () => {
  test("keeps an unready default visible with its label instead of a raw id", () => {
    const models = [creditsDefault, codex];
    const rows = defaultModelPickerRows(projectPickerRows(models), models, "gpt-6-astra");
    const selected = rows.find((row) => row.id === "gpt-6-astra");
    expect(selected?.label).toBe("GPT-6 Astra");
    expect(selected?.billingClass).toBe("opengeni_credits");
    expect(selected?.selectable).toBe(false);
    expect(selected?.unavailableReason).toBe("Credentials required");
  });

  test("does not invent rows for ids the catalog does not know", () => {
    const rows = projectPickerRows([codex]);
    expect(defaultModelPickerRows(rows, [codex], "unknown-model")).toBe(rows);
    expect(defaultModelSummary([codex], "unknown-model")).toBeNull();
  });

  test("names the payer and flags a default that cannot run", () => {
    expect(defaultModelSummary([creditsDefault], "gpt-6-astra")).toEqual({
      text: "GPT-6 Astra · Opengeni credits",
      unavailable: "Can't run right now: Credentials required",
    });
    expect(defaultModelSummary([codex], "codex/gpt-6-astra")).toEqual({
      text: "GPT-6 Astra · Codex subscription · external billing",
      unavailable: null,
    });
  });
});
