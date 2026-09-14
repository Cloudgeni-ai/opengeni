import type { OpenGeniClient } from "./client";

export type OrganizationIntegrationPolicy = {
  mode: "unrestricted" | "restricted";
  allowedIntegrationKeys: string[];
  revision: number;
};

export type UpdateOrganizationIntegrationPolicyRequest = {
  mode: "unrestricted" | "restricted";
  allowedIntegrationKeys: string[];
  expectedRevision: number;
  operationId: string;
};

type PolicyClient = Pick<OpenGeniClient, "requestJson">;

export async function getOrganizationIntegrationPolicy(
  client: PolicyClient,
  organizationId: string,
): Promise<OrganizationIntegrationPolicy> {
  return client.requestJson("GET", `/v1/organizations/${organizationId}/integration-policy`);
}

/** Retain operationId and the exact request when reconciling an uncertain outcome. */
export async function updateOrganizationIntegrationPolicy(
  client: PolicyClient,
  organizationId: string,
  request: UpdateOrganizationIntegrationPolicyRequest,
): Promise<OrganizationIntegrationPolicy> {
  return client.requestJson(
    "PUT",
    `/v1/organizations/${organizationId}/integration-policy`,
    request,
  );
}
