import type { OpenGeniClient } from "./client";

export type OrganizationIntegrationPolicy = {
  mode: "unrestricted" | "restricted";
  allowedIntegrationKeys: string[];
  /**
   * Who may turn on a reviewed OAuth integration for personal accounts:
   * `members` (anyone with `connections:personal`, which `connections:write`
   * includes; the default) or only integration `admins`. Each person still
   * connects their own account; admins are unaffected.
   */
  personalIntegrationSetup: "members" | "admins";
  revision: number;
};

export type UpdateOrganizationIntegrationPolicyRequest = {
  mode: "unrestricted" | "restricted";
  allowedIntegrationKeys: string[];
  /** Omitted keeps the current setting. */
  personalIntegrationSetup?: "members" | "admins" | undefined;
  expectedRevision: number;
  operationId: string;
};

type PolicyClient = Pick<OpenGeniClient, "requestJson">;

export type OrganizationIntegrationCatalog = {
  integrations: Array<{ key: string; label: string; kind: "curated" | "custom" }>;
};

/** Discover stable policy identities; integrations must not guess provider identifiers. */
export async function getOrganizationIntegrationCatalog(
  client: PolicyClient,
  organizationId: string,
): Promise<OrganizationIntegrationCatalog> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/integration-policy/catalog`,
  );
}

export async function getOrganizationIntegrationPolicy(
  client: PolicyClient,
  organizationId: string,
): Promise<OrganizationIntegrationPolicy> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/integration-policy`,
  );
}

/** Retain operationId and the exact request when reconciling an uncertain outcome. */
export async function updateOrganizationIntegrationPolicy(
  client: PolicyClient,
  organizationId: string,
  request: UpdateOrganizationIntegrationPolicyRequest,
): Promise<OrganizationIntegrationPolicy> {
  return client.requestJson(
    "PUT",
    `/v1/organizations/${encodeURIComponent(organizationId)}/integration-policy`,
    request,
  );
}
