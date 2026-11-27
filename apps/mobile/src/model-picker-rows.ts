import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import type { OpenGeniText } from "@opengeni/react/messages";
import {
  projectPickerRows,
  sortPickerRows,
  type PickerModelRow,
} from "@opengeni/react/model-policy";

/**
 * The native model sheet's rows in the web picker's order. Without purchase
 * prompts (the iOS app), a model the plan doesn't include says so without
 * naming the plan to buy.
 */
export function workspacePickerRows(
  t: OpenGeniText,
  models: WorkspaceModelCatalogModel[],
  options: { showPurchasePrompts: boolean },
): PickerModelRow[] {
  return sortPickerRows(projectPickerRows(t, models, options));
}
