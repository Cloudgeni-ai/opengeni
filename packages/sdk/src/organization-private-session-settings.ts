import type { OpenGeniClient } from "./client";
import type {
  OrganizationPrivateSessionSettings,
  UpdateOrganizationPrivateSessionSettingsRequest,
} from "./types";

type OrganizationPrivateSessionSettingsClient = Pick<OpenGeniClient, "requestJson">;

function settingsPath(organizationId: string): string {
  return `/v1/organizations/${organizationId}/private-session-settings`;
}

export async function getOrganizationPrivateSessionSettings(
  client: OrganizationPrivateSessionSettingsClient,
  organizationId: string,
): Promise<OrganizationPrivateSessionSettings> {
  return await client.requestJson<OrganizationPrivateSessionSettings>(
    "GET",
    settingsPath(organizationId),
  );
}

export async function updateOrganizationPrivateSessionSettings(
  client: OrganizationPrivateSessionSettingsClient,
  organizationId: string,
  request: UpdateOrganizationPrivateSessionSettingsRequest,
): Promise<OrganizationPrivateSessionSettings> {
  return await client.requestJson<OrganizationPrivateSessionSettings>(
    "PATCH",
    settingsPath(organizationId),
    request,
  );
}
