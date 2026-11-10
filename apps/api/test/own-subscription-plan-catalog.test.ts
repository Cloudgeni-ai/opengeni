import { expect, test } from "bun:test";
import type { WorkspaceModelCatalogResponse } from "@opengeni/contracts";
import { withOwnSubscriptionPlan } from "../src/own-subscription-plan";

// The model catalog names the plan an organization needs before its own
// subscriptions run: once for the page, and on each own-subscription model.

const PRO = { key: "pro", label: "Pro", monthlyPriceMicros: 20_000_000 };

function catalogModel(id: string) {
  return { id, label: id } as unknown as WorkspaceModelCatalogResponse["models"][number];
}

function selection(
  id: string,
  credentialSource: { kind: string; provider?: string },
  upstreamPayer: string,
) {
  return {
    model: { id, credentialSource, billing: { upstreamPayer, metering: "external" } },
  } as never;
}

const selections = [
  selection(
    "codex/gpt-6-astra",
    { kind: "connected_subscription", provider: "codex" },
    "connected_subscription",
  ),
  selection(
    "supergrok/grok-4.6",
    { kind: "connected_subscription", provider: "xai" },
    "connected_subscription",
  ),
  selection("gpt-6-luna", { kind: "deployment" }, "deployment"),
  selection("workspace-openrouter/x", { kind: "workspace_connection" }, "workspace"),
];

const catalog: WorkspaceModelCatalogResponse = {
  models: [
    catalogModel("codex/gpt-6-astra"),
    catalogModel("supergrok/grok-4.6"),
    catalogModel("gpt-6-luna"),
    catalogModel("workspace-openrouter/x"),
  ],
};

test("marks only own-subscription models, and the page, with the plan they need", () => {
  const marked = withOwnSubscriptionPlan(catalog, selections, PRO);
  expect(marked.ownSubscriptionPlan).toEqual(PRO);
  expect(
    Object.fromEntries(marked.models.map((model) => [model.id, model.requiredPlan ?? null])),
  ).toEqual({
    "codex/gpt-6-astra": PRO,
    "supergrok/grok-4.6": PRO,
    "gpt-6-luna": null,
    "workspace-openrouter/x": null,
  });
});

test("leaves the catalog unchanged when the plan includes own subscriptions", () => {
  expect(withOwnSubscriptionPlan(catalog, selections, null)).toBe(catalog);
});
