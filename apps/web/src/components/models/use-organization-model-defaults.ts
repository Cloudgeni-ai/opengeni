import type {
  OrganizationModelDefaults,
  UpdateOrganizationModelDefaultsRequest,
} from "@opengeni/sdk";
import { useCallback } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import { sharedQueryWriter, useSharedQuery } from "@opengeni/react/app/lib/shared-query";

/* ----------------------------------------------------------------------------
   The model defaults every workspace in an organization follows until it sets
   its own: the default model, Allowed models and compaction limits. Read and
   changed by organization owners and admins on the organization's Models
   page. Workspace pages never read these directly; their own model routes say
   which values they follow.
   -------------------------------------------------------------------------- */

export type OrganizationModelDefaultsState = {
  defaults: OrganizationModelDefaults | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  /** Saves one change and keeps the saved result. Throws the failure for the caller to show. */
  update: (request: UpdateOrganizationModelDefaultsRequest) => Promise<OrganizationModelDefaults>;
};

export function useOrganizationModelDefaults(
  organizationId: string | undefined,
  enabled: boolean,
): OrganizationModelDefaultsState {
  const client = useAppContext().client;
  const {
    data: defaults,
    loading,
    error,
    refresh: reload,
  } = useSharedQuery(
    client,
    ["model-settings", "organization-defaults", organizationId ?? null],
    () => client.getOrganizationModelDefaults(organizationId!),
    { enabled: enabled && Boolean(organizationId), staleTimeMs: 300_000 },
  );

  const update = useCallback(
    async (request: UpdateOrganizationModelDefaultsRequest) => {
      if (!organizationId) throw new Error("This workspace has no organization.");
      const write = sharedQueryWriter(client);
      const saved = await client.updateOrganizationModelDefaults(organizationId, request);
      write(["model-settings", "organization-defaults", organizationId], saved);
      // Workspace catalogs resolve defaults and limits from these.
      window.dispatchEvent(new Event("model-connections-changed"));
      return saved;
    },
    [client, organizationId],
  );

  return { defaults, loading, error, reload, update };
}
