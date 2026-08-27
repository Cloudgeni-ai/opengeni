import type { OpenGeniClient } from "./client";
import type {
  OrganizationUserSetupDelivery,
  OrganizationUserSetupPreview,
  PreviewOrganizationUserSetupRequest,
  RetryOrganizationUserSetupDeliveryRequest,
} from "./types";

type OrganizationUserSetupClient = Pick<OpenGeniClient, "requestJson">;

/** Safe signed-out projection of the exact organization role and shared access in a setup link. */
export function previewOrganizationUserSetup(
  client: OrganizationUserSetupClient,
  request: PreviewOrganizationUserSetupRequest,
): Promise<OrganizationUserSetupPreview> {
  return client.requestJson("POST", "/v1/auth/organization-setup/preview", request);
}

/** Retry a failed or explicitly outcome-unknown delivery with its stable provider key. */
export function retryOrganizationUserSetupDelivery(
  client: OrganizationUserSetupClient,
  organizationId: string,
  invitationId: string,
  request: RetryOrganizationUserSetupDeliveryRequest,
): Promise<OrganizationUserSetupDelivery> {
  return client.requestJson(
    "POST",
    `/v1/organizations/${organizationId}/invitations/${invitationId}/delivery/retry`,
    request,
  );
}
