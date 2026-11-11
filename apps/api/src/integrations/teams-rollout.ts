import { isIntegrationDefinitionEnabled } from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

export function integrationAvailable(
  settings: Settings,
  workspaceId: string,
  definitionId: string,
): boolean {
  return isIntegrationDefinitionEnabled(definitionId, {
    teamsEnabled: settings.microsoftTeamsToolsEnabled,
    teamsAllowedWorkspaceIds: settings.microsoftTeamsAllowedWorkspaceIds,
    workspaceId,
  });
}

export function requireIntegrationAvailable(
  settings: Settings,
  workspaceId: string,
  definitionId: string,
): void {
  if (!integrationAvailable(settings, workspaceId, definitionId)) {
    throw new HTTPException(404, { message: "Integration is not available in this workspace" });
  }
}
