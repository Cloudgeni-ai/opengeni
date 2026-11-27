import { describe, expect, test } from "bun:test";
import { createOpenGeniText } from "@opengeni/react/messages";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { workspacePickerRows } from "./model-picker-rows";

const t = createOpenGeniText();

const needsPro: WorkspaceModelCatalogModel = {
  id: "codex/gpt-6-astra",
  label: "Astra",
  provider: "openai",
  providerLabel: "OpenAI",
  api: "responses",
  cost: "subscription",
  requiredPlan: { key: "pro", label: "Pro", monthlyPriceMicros: 20_000_000 },
  credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
  policyAllowed: true,
  availability: { status: "available", selectable: true, reason: null, checkedAt: null },
};

describe("workspace picker rows", () => {
  test("name the plan to buy only where purchase prompts are shown", () => {
    const [shown] = workspacePickerRows(t, [needsPro], { showPurchasePrompts: true });
    const [quiet] = workspacePickerRows(t, [needsPro], { showPurchasePrompts: false });
    expect(shown?.fundingHint).toBe("Needs Pro");
    expect(quiet?.fundingHint).toBe("Not available on your current plan");
    expect(quiet?.selectable).toBe(shown?.selectable);
  });
});
