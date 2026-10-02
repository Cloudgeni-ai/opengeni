import { expect, test } from "bun:test";
import type { ClientModel, WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { projectPickerRows } from "@opengeni/react";
import { connectableSubscriptions, isDeploymentFreeModel } from "./deployment-free-model";

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id">,
): WorkspaceModelCatalogModel {
  return {
    label: overrides.id,
    provider: "openrouter",
    providerLabel: "OpenRouter",
    api: "chat",
    source: "opengeni",
    cost: "credits",
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    policyAllowed: true,
    availability: { status: "available", selectable: true, reason: null, checkedAt: null },
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

const rows = projectPickerRows([
  catalogModel({ id: "openrouter/free-default", cost: "free" }),
  catalogModel({ id: "openai/gpt-credits", cost: "credits" }),
  // A workspace's own OpenRouter account, even on an upstream free model.
  catalogModel({
    id: "workspace-openrouter/meta-llama:free",
    provider: "workspace-openrouter",
    source: "openrouter",
    cost: "workspace",
  }),
]);

test("only the deployment's free catalog row counts as the free model", () => {
  expect(isDeploymentFreeModel(rows, "openrouter/free-default")).toBe(true);
  expect(isDeploymentFreeModel(rows, "openai/gpt-credits")).toBe(false);
  expect(isDeploymentFreeModel(rows, "workspace-openrouter/meta-llama:free")).toBe(false);
  expect(isDeploymentFreeModel(rows, "unknown/model")).toBe(false);
  // The catalog may still be loading: no rows means no free-model copy yet.
  expect(isDeploymentFreeModel([], "openrouter/free-default")).toBe(false);
});

test("reads connectable subscriptions from the deployment's client catalog", () => {
  const model = (source: ClientModel["source"]): ClientModel => ({
    id: `${source}/model`,
    label: "Model",
    provider: String(source),
    providerLabel: "Provider",
    api: "responses",
    source,
  });
  expect(connectableSubscriptions([model("opengeni"), model("openrouter")])).toEqual({
    codex: false,
    supergrok: false,
  });
  expect(connectableSubscriptions([model("opengeni"), model("codex")])).toEqual({
    codex: true,
    supergrok: false,
  });
  expect(connectableSubscriptions([model("supergrok")])).toEqual({
    codex: false,
    supergrok: true,
  });
  expect(connectableSubscriptions([model("codex"), model("supergrok")])).toEqual({
    codex: true,
    supergrok: true,
  });
});
