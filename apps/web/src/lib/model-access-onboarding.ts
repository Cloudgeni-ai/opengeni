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

/** Select the connected model in the actor-private draft without workspace administration. */
export async function applyConnectedModelToNewSessionDraft(
  client: OpenGeniBrowserClient,
  workspaceId: string,
): Promise<string | null> {
  const catalog = await client.getWorkspaceModelCatalog(workspaceId);
  const modelId = preferredConnectedModelId(catalog.models);
  if (!modelId) return null;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  const draft = await client.getNewSessionDraft(workspaceId);
  await client.saveNewSessionDraft(workspaceId, {
    text: draft.text,
    resources: draft.resources,
    tools: draft.tools,
    toolsProvided: draft.toolsProvided,
    model: modelId,
    reasoningEffort: model ? defaultEffortForModel(model) : "low",
    latencyMode: draft.latencyMode,
    ...(draft.selectedProjectChannelId !== undefined
      ? { selectedProjectChannelId: draft.selectedProjectChannelId }
      : {}),
    options: draft.options,
    expectedRevision: draft.revision,
  });
  return modelId;
}
