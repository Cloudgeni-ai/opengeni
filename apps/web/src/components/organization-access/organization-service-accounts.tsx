import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useMemo } from "react";

import {
  ServiceAccounts,
  type ServiceAccountsApi,
  type ServiceAccountsLocation,
} from "@/components/organization-access/service-accounts";

/** Organization settings > Developer > Service accounts, on the live API. */
export function OrganizationServiceAccounts({
  client,
  organizationId,
  canMakeAdmin,
  location,
  onNavigate,
  onCreateKey,
}: {
  client: OpenGeniBrowserClient;
  organizationId: string;
  canMakeAdmin: boolean;
  location: ServiceAccountsLocation;
  onNavigate: (next: ServiceAccountsLocation) => void;
  onCreateKey: (serviceAccountId: string) => void;
}) {
  const api = useMemo<ServiceAccountsApi>(
    () => ({
      list: async () =>
        (await client.listOrganizationServiceAccounts(organizationId)).serviceAccounts,
      get: async (id) => await client.getOrganizationServiceAccount(organizationId, id),
      create: async (request) =>
        await client.createOrganizationServiceAccount(organizationId, request),
      update: async (id, request) =>
        await client.updateOrganizationServiceAccount(organizationId, id, request),
      remove: async (id) => await client.deleteOrganizationServiceAccount(organizationId, id),
      listKeys: async () => await client.listOrganizationApiKeys(organizationId),
    }),
    [client, organizationId],
  );
  return (
    <ServiceAccounts
      api={api}
      canMakeAdmin={canMakeAdmin}
      location={location}
      onNavigate={onNavigate}
      onCreateKey={onCreateKey}
    />
  );
}
