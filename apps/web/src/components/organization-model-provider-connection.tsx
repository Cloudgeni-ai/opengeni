import { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
export { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
  modelConnectionClass,
} from "@/lib/integration-connect-analytics";
import { claudeModelLabel } from "@/components/models/claude-setup";
import type {
  OrganizationModelProviderConnection as Connection,
  OrganizationModelProviderKind as ProviderKind,
  OrganizationProviderCustomModel as CustomModel,
} from "@opengeni/sdk";
import { WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH } from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ProviderConnectionView } from "@/components/ai-gateway-connection";
import { useClaudeUsage } from "@/components/models/claude-usage";
import { userErrorText } from "@opengeni/react/ui/api-error";
import {
  invalidateSharedQueries,
  peekSharedQuery,
  sharedQueryWriter,
  useSharedQuery,
} from "@/lib/shared-query";

// Organization API-key providers (Vercel AI Gateway, OpenRouter, Opper) shared with
// the organization's workspaces. Returns the same view as the workspace hook,
// so Organization settings > Models reuses the row and the provider's page.

export function useOrganizationProviderConnection({
  organizationId,
  providerKind,
  client,
  enabled = true,
  catalogConnection,
}: {
  organizationId: string;
  providerKind: ProviderKind;
  client: OpenGeniBrowserClient;
  enabled?: boolean;
  catalogConnection?: { connected: boolean; loaded: boolean; error: Error | null };
}): ProviderConnectionView {
  const meta = ORGANIZATION_PROVIDER_META[providerKind];
  const hasCatalogConnection = Boolean(catalogConnection);
  const connectionKey = [
    "model-settings",
    "organization-provider",
    organizationId,
    providerKind,
    "connection",
  ] as const;
  const modelsKey = [
    "model-settings",
    "organization-provider",
    organizationId,
    providerKind,
    "models",
  ] as const;
  const connectionQuery = useSharedQuery(
    client,
    connectionKey,
    () => client.getOrganizationModelProviderConnection(organizationId, providerKind),
    { enabled: enabled && !hasCatalogConnection, staleTimeMs: 5 * 60_000 },
  );
  const modelsQuery = useSharedQuery(
    client,
    modelsKey,
    async () =>
      (await client.listOrganizationProviderCustomModels(organizationId, providerKind)).models,
    { enabled, staleTimeMs: 5 * 60_000 },
  );
  const connection = connectionQuery.data;
  const models = modelsQuery.data ?? [];
  const { refresh: readConnection } = connectionQuery;
  const { refresh: readModels } = modelsQuery;
  const loaded = !connectionQuery.loading;
  const modelsLoaded = !modelsQuery.loading;
  const [slug, setSlug] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemovalState, setPendingRemovalState] = useState<CustomModel | null>(null);
  const identity = JSON.stringify([organizationId, providerKind, enabled, hasCatalogConnection]);
  const epochRef = useRef({ client, identity, active: true });
  if (epochRef.current.client !== client || epochRef.current.identity !== identity) {
    epochRef.current.active = false;
    epochRef.current = { client, identity, active: true };
  }
  const epoch = epochRef.current;
  const pendingSaveRef = useRef<{
    key: string;
    version: number;
    operationId: string;
  } | null>(null);
  const pendingCreateRef = useRef<{ slug: string; operationId: string } | null>(null);
  const pendingDeletesRef = useRef(new Map<string, string>());
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const removalFocusRef = useRef<HTMLElement | null>(null);
  const addWorkflowRef = useRef<HTMLDivElement | null>(null);
  const restoreRemovalFocusRef = useRef(false);

  useEffect(() => {
    epoch.active = true;
    setConnectionBusy(false);
    setModelBusy(false);
    setRemovingId(null);
    setSlug("");
    setPendingRemovalState(null);
    pendingSaveRef.current = null;
    pendingCreateRef.current = null;
    pendingDeletesRef.current.clear();
    return () => {
      epoch.active = false;
    };
  }, [epoch]);

  const connected = catalogConnection?.connected ?? connection?.status === "active";

  const slugValid =
    slug.length <= WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH &&
    /^[!-{}-~]+$/.test(slug);
  const slugExists = models.some((model) => model.upstreamModelId === slug);
  const slugInvalid = slug.length > 0 && (!slugValid || slugExists);
  const slugHelp = slugExists
    ? "That exact model slug is already configured."
    : slug && !slugValid
      ? "Use the exact printable model slug with no spaces or |."
      : connected
        ? "It becomes selectable in shared workspaces when workspace policy allows it."
        : `Add models now; they become selectable after ${meta.shortName} is connected.`;

  const refreshConnection = useCallback(async (): Promise<Connection | null | undefined> => {
    if (!enabled || hasCatalogConnection) return undefined;
    await readConnection();
    const snapshot = peekSharedQuery<Connection>(client, [
      "model-settings",
      "organization-provider",
      organizationId,
      providerKind,
      "connection",
    ]);
    return snapshot?.error ? undefined : snapshot?.data;
  }, [client, organizationId, providerKind, enabled, hasCatalogConnection, readConnection]);

  const claudeUsage = useClaudeUsage({
    client,
    scope: "organization",
    scopeId: organizationId,
    enabled: enabled && !catalogConnection && providerKind === "claude_subscription",
    connected,
    credentialVersion: connection?.version,
    canManage: true,
    onCredentialChanged: refreshConnection,
  });

  const refreshModels = useCallback(async (): Promise<CustomModel[] | undefined> => {
    if (!enabled) return undefined;
    await readModels();
    const snapshot = peekSharedQuery<CustomModel[]>(client, [
      "model-settings",
      "organization-provider",
      organizationId,
      providerKind,
      "models",
    ]);
    return snapshot?.error ? undefined : (snapshot?.data ?? undefined);
  }, [client, organizationId, providerKind, enabled, readModels]);

  async function saveKey(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!epoch.active || !enabled || !key || catalogConnection || connectionBusy) return false;
    const write = sharedQueryWriter(client);
    const credentialIdentity = key;
    const version = connection?.version ?? 0;
    const pending = pendingSaveRef.current;
    const operationId =
      pending?.key === credentialIdentity && pending.version === version
        ? pending.operationId
        : crypto.randomUUID();
    pendingSaveRef.current = { key: credentialIdentity, version, operationId };
    setConnectionBusy(true);
    const journey = beginIntegrationConnect(
      modelConnectionClass(providerKind) ?? "other",
      "api_key",
    );
    const mutate = () =>
      client.upsertOrganizationModelProviderConnection(organizationId, providerKind, {
        operationId,
        expectedVersion: version,
        apiKey: key,
      });
    const commit = (saved: Connection) => {
      journey.finish("connected");
      write(connectionKey, saved);
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return;
      pendingSaveRef.current = null;
      toast.success(`${meta.title} connected for shared workspaces`);
    };
    try {
      commit(await mutate());
      return true;
    } catch (error) {
      let finalError = error;
      const outcomeUnknown =
        error instanceof OpenGeniApiError ? error.outcomeUnknown : error instanceof Error;
      if (outcomeUnknown) {
        try {
          commit(await mutate());
          return true;
        } catch (retryError) {
          finalError = retryError;
        }
      }
      // A newer version can belong to another administrator. Only the mutation's
      // idempotent receipt proves that this token and identity were committed.
      journey.finish(integrationConnectErrorOutcome(finalError));
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return false;
      await refreshConnection();
      toast.error(`Couldn't connect ${meta.title}`, {
        description: userErrorText(finalError),
      });
      return false;
    } finally {
      if (epoch.active) setConnectionBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!epoch.active || !enabled || catalogConnection) return false;
    if (!connection || connection.status !== "active") return true;
    const write = sharedQueryWriter(client);
    setConnectionBusy(true);
    const operationId = crypto.randomUUID();
    const mutate = () =>
      client.revokeOrganizationModelProviderConnection(organizationId, providerKind, {
        operationId,
        expectedVersion: connection.version,
      });
    try {
      let revoked: Connection;
      try {
        revoked = await mutate();
      } catch {
        revoked = await mutate();
      }
      write(connectionKey, revoked);
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return true;
      toast.success(`${meta.title} disconnected`);
      return true;
    } catch (error) {
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return false;
      const reconciled = await refreshConnection();
      if (reconciled === null || reconciled?.status === "revoked") {
        toast.success(`${meta.title} disconnected`);
        return true;
      }
      toast.error(`Couldn't disconnect ${meta.title}`, {
        description: userErrorText(error),
      });
      return false;
    } finally {
      if (epoch.active) setConnectionBusy(false);
    }
  }

  async function addModel(upstreamModelId?: string): Promise<void> {
    const submittedSlug = upstreamModelId ?? slug;
    if (
      !epoch.active ||
      !enabled ||
      modelBusy ||
      !submittedSlug ||
      submittedSlug.length > WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH ||
      !/^[!-{}-~]+$/.test(submittedSlug) ||
      models.some((model) => model.upstreamModelId === submittedSlug)
    )
      return;
    const pending = pendingCreateRef.current;
    const operationId = pending?.slug === submittedSlug ? pending.operationId : crypto.randomUUID();
    pendingCreateRef.current = { slug: submittedSlug, operationId };
    const write = sharedQueryWriter(client);
    setModelBusy(true);
    const mutate = () =>
      client.createOrganizationProviderCustomModel(organizationId, providerKind, {
        operationId,
        upstreamModelId: submittedSlug,
        ...((providerKind === "anthropic" || providerKind === "claude_subscription") &&
        claudeModelLabel(submittedSlug) !== submittedSlug
          ? { label: claudeModelLabel(submittedSlug) }
          : {}),
      });
    const commit = (saved: CustomModel) => {
      const cachedModels = peekSharedQuery<CustomModel[]>(client, modelsKey)?.data ?? [];
      write(modelsKey, [
        ...cachedModels.filter(
          (candidate) =>
            candidate.id !== saved.id && candidate.upstreamModelId !== saved.upstreamModelId,
        ),
        saved,
      ]);
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return;
      pendingCreateRef.current = null;
      setSlug((current) => (current === submittedSlug ? "" : current));
      toast.success(`${meta.title} model added`, {
        description: connected
          ? "It can now appear in shared-workspace model pickers."
          : `It will become selectable after ${meta.shortName} is connected.`,
      });
    };
    try {
      let saved: CustomModel;
      try {
        saved = await mutate();
      } catch {
        saved = await mutate();
      }
      commit(saved);
    } catch (error) {
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return;
      const reconciled = await refreshModels();
      const committed = reconciled?.find((model) => model.upstreamModelId === submittedSlug);
      if (committed) commit(committed);
      else
        toast.error(`Couldn't add ${meta.title} model`, {
          description: userErrorText(error),
        });
    } finally {
      if (epoch.active) {
        setModelBusy(false);
        modelInputRef.current?.focus();
      }
    }
  }

  async function removeModel(model: CustomModel): Promise<boolean> {
    if (!epoch.active || !enabled) return false;
    const write = sharedQueryWriter(client);
    setRemovingId(model.id);
    const operationId = pendingDeletesRef.current.get(model.id) ?? crypto.randomUUID();
    pendingDeletesRef.current.set(model.id, operationId);
    const mutate = () =>
      client.deleteOrganizationProviderCustomModel(organizationId, providerKind, model.id, {
        operationId,
        expectedVersion: model.version,
      });
    const commit = () => {
      const current = peekSharedQuery<CustomModel[]>(client, modelsKey)?.data ?? [];
      write(
        modelsKey,
        current.filter((candidate) => candidate.id !== model.id),
      );
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return;
      pendingDeletesRef.current.delete(model.id);
      toast.success(`${meta.title} model removed`);
    };
    try {
      try {
        await mutate();
      } catch {
        await mutate();
      }
      commit();
      return true;
    } catch (error) {
      void invalidateSharedQueries(client, ["model-settings"]);
      if (!epoch.active) return false;
      const reconciled = await refreshModels();
      if (reconciled && !reconciled.some((candidate) => candidate.id === model.id)) {
        commit();
        return true;
      }
      toast.error(`Couldn't remove ${meta.title} model`, {
        description: userErrorText(error),
      });
      return false;
    } finally {
      if (epoch.active) setRemovingId(null);
    }
  }

  return {
    config: meta,
    scopeLabel: "Organization",
    organization: true,
    accessTarget: { client, organizationId, kind: providerKind, connectionId: "current" },
    canManageConnection: enabled && !catalogConnection,
    canManageCustomModels: enabled,
    connected,
    settled: !enabled || ((catalogConnection?.loaded ?? loaded) && modelsLoaded),
    hidden: !enabled || Boolean(catalogConnection),
    error: catalogConnection?.error ?? connectionQuery.error,
    customModelsError: modelsQuery.error,
    customModels: models,
    customModelsLoaded: modelsLoaded,
    claudeUsage: providerKind === "claude_subscription" ? claudeUsage : undefined,
    busy: connectionBusy,
    modelSlug: slug,
    modelBusy,
    modelSlugValid: slugValid,
    modelSlugExists: slugExists,
    modelSlugInvalid: slugInvalid,
    modelSlugHelp: slugHelp,
    removingModelId: removingId,
    modelPendingRemoval: pendingRemovalState,
    modelInputRef,
    addWorkflowRef,
    removeButtonRefs,
    removeFocusTargetRef: removalFocusRef,
    restoreRemovalFocusRef,
    setModelSlug: setSlug,
    setModelPendingRemoval: (model) => setPendingRemovalState(model as CustomModel | null),
    refreshConnection,
    refreshCustomModels: refreshModels,
    saveKey,
    disconnect,
    addCustomModel: addModel,
    removeCustomModel: (model) => removeModel(model as CustomModel),
  };
}
