import type {
  OrganizationModelDefaults,
  UpdateOrganizationModelDefaultsRequest,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppContext } from "@/context";

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
  const [defaults, setDefaults] = useState<OrganizationModelDefaults | null>(null);
  const [loading, setLoading] = useState(enabled && Boolean(organizationId));
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!enabled || !organizationId) {
      setDefaults(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loaded = await client.getOrganizationModelDefaults(organizationId);
      if (current === generation.current) setDefaults(loaded);
    } catch (caught) {
      if (current !== generation.current) return;
      setDefaults(null);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, enabled, organizationId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  const update = useCallback(
    async (request: UpdateOrganizationModelDefaultsRequest) => {
      if (!organizationId) throw new Error("This workspace has no organization.");
      const saved = await client.updateOrganizationModelDefaults(organizationId, request);
      generation.current += 1;
      setDefaults(saved);
      setError(null);
      setLoading(false);
      // Workspace catalogs resolve defaults and limits from these.
      window.dispatchEvent(new Event("model-connections-changed"));
      return saved;
    },
    [client, organizationId],
  );

  return { defaults, loading, error, reload, update };
}
