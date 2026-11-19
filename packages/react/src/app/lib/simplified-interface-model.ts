import type { ClientConfig, ReasoningEffort } from "@opengeni/contracts";

/**
 * The simplified interface has no model choice: every new chat runs one model at one
 * reasoning level, paid with the organization's credits. This names that
 * model; the picker is hidden and the composer state is pinned to it.
 */
export const SIMPLIFIED_INTERFACE_MODEL_SLUG = "gpt-6.1-sol";
export const SIMPLIFIED_INTERFACE_REASONING_EFFORT: ReasoningEffort = "medium";

export type SimplifiedInterfaceModelPolicy = { model: string; reasoningEffort: ReasoningEffort };

type ModelCatalog = Pick<ClientConfig, "defaultModel" | "defaultReasoningEffort" | "models">;

/**
 * The model policy every chat started in the simplified interface uses on
 * this deployment.
 *
 * Deployments name the same model differently (`gpt-6.1-sol`,
 * `azure-sol/gpt-6.1-sol`), so it is matched by its last path segment, and
 * only among models paid with the product's own credits. A deployment that
 * does not offer it (a local stack, for example) uses its default model
 * instead, so there is always exactly one policy and never an empty picker.
 */
export function simplifiedInterfaceModelPolicy(
  config: ModelCatalog,
): SimplifiedInterfaceModelPolicy {
  const pinned = config.models.find(
    (model) =>
      (model.source === undefined || model.source === "opengeni") &&
      (model.id === SIMPLIFIED_INTERFACE_MODEL_SLUG ||
        model.id.endsWith(`/${SIMPLIFIED_INTERFACE_MODEL_SLUG}`)),
  );
  const chosen = pinned ?? config.models.find((model) => model.id === config.defaultModel);
  const efforts = chosen?.capabilities?.reasoning?.efforts;
  const reasoningEffort =
    !efforts || efforts.includes(SIMPLIFIED_INTERFACE_REASONING_EFFORT)
      ? SIMPLIFIED_INTERFACE_REASONING_EFFORT
      : (chosen?.capabilities?.reasoning?.defaultEffort ?? config.defaultReasoningEffort);
  return { model: chosen?.id ?? config.defaultModel, reasoningEffort };
}
