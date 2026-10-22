import type { Hono } from "hono";
import { variableSetsRemovedResponse } from "../http/variable-sets-removed";

/**
 * Variable Sets were replaced by vaults (RM-1). Every legacy route, including
 * the deprecated `/environments` alias, answers 410 `variable_sets_removed`
 * with a pointer to `/vaults`. No grant is checked: the answer reveals nothing.
 */
const LEGACY_PREFIXES = [
  "/v1/workspaces/:workspaceId/variable-sets",
  "/v1/workspaces/:workspaceId/environments",
] as const;

export function registerVariableSetsRemovedRoutes(app: Hono): void {
  for (const prefix of LEGACY_PREFIXES) {
    app.all(prefix, (c) => variableSetsRemovedResponse(c, 410));
    app.all(`${prefix}/*`, (c) => variableSetsRemovedResponse(c, 410));
  }
}
