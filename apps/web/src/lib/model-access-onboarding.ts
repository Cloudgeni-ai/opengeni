import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { defaultEffortForModel, projectPickerRows, sortPickerRows } from "@opengeni/react";

const CONNECTED_BILLING_CLASSES = new Set([
  "codex_subscription",
  "supergrok_subscription",
  "byok",
  "organization_byok",
  "external",
]);

/** First selectable non-credit model after a subscription or provider connect. */
export function preferredConnectedModelId(
  models: readonly WorkspaceModelCatalogModel[],
): string | null {
  const connected = sortPickerRows(projectPickerRows([...models])).filter(
    (row) => row.selectable && CONNECTED_BILLING_CLASSES.has(row.billingClass),
  );
  return connected[0]?.id ?? null;
}

export function isPaymentRequiredError(error: unknown): error is OpenGeniApiError {
  return (
    error instanceof OpenGeniApiError && error.status === 402 && error.code === "payment_required"
  );
}

/** Persist a connected model as the workspace default so new chats preselect it. */
export async function applyConnectedModelAsWorkspaceDefault(
  client: OpenGeniBrowserClient,
  workspaceId: string,
): Promise<string | null> {
  const catalog = await client.getWorkspaceModelCatalog(workspaceId);
  const modelId = preferredConnectedModelId(catalog.models);
  if (!modelId) return null;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  await client.updateWorkspaceSettings(workspaceId, {
    sessionDefaults: {
      model: modelId,
      reasoningEffort: model ? defaultEffortForModel(model) : "low",
    },
  });
  return modelId;
}
