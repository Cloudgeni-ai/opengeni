import { CODEX_MODEL_ID_PREFIX } from "./constants";

/**
 * Pure NECESSARY condition for a Codex-billed turn: the model id is namespaced
 * for the Codex subscription provider (`codex/<slug>`).
 *
 * This is NOT sufficient to bypass billing — an active, connected workspace
 * credential and the deployment flag (`settings.codexSubscriptionEnabled`) are
 * ALSO required (see `isCodexBilledTurn`/`workspaceCodexSubscriptionActive` in
 * `@opengeni/db`). Used only as a cheap, synchronous short-circuit so the common
 * non-codex path never issues a credential read.
 */
export function isCodexBilledModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(CODEX_MODEL_ID_PREFIX);
}
