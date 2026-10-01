import type { ClientModel } from "@opengeni/sdk";

import { findPickerRow, type PickerModelRow } from "@/lib/model-policy";

/** Subscriptions this deployment lets a workspace connect. */
export type ConnectableSubscriptions = { codex: boolean; supergrok: boolean };

/**
 * Whether `modelId` is the deployment's free model. Only deployment config sets
 * catalog `cost: "free"`; a workspace's own provider rows never carry it.
 * Pass the failed turn's model (`session.model`), not the composer's pick.
 */
export function isDeploymentFreeModel(rows: PickerModelRow[], modelId: string): boolean {
  return findPickerRow(rows, modelId)?.catalog.cost === "free";
}

/**
 * Read from the client-config catalog the same way organization onboarding
 * does: a subscription is connectable when the deployment lists its models.
 */
export function connectableSubscriptions(models: readonly ClientModel[]): ConnectableSubscriptions {
  return {
    codex: models.some((model) => model.source === "codex"),
    supergrok: models.some((model) => model.source === "supergrok"),
  };
}
