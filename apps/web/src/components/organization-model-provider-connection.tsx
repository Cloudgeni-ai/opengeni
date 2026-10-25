import { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
export { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
  modelConnectionClass,
} from "@opengeni/react/app/lib/integration-connect-analytics";
import { claudeModelLabel } from "@/components/models/claude-setup";
import type {
  OrganizationModelProviderConnection as Connection,
  OrganizationModelCatalogProviderKind as ProviderKind,
  OrganizationProviderCustomModel as CustomModel,
} from "@opengeni/sdk";
import {
  DirectModelName,
  WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH,
  type OrganizationModelProviderAuthMethod,
  type OrganizationModelProviderEntraAuthentication,
} from "@opengeni/contracts";
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
} from "@opengeni/react/app/lib/shared-query";

// Organization API-key providers (Vercel AI Gateway, OpenRouter, Opper, Azure
// OpenAI) shared with the organization's workspaces. Returns the same view as the
// workspace hook, so Organization settings > Models reuses the row and the
// provider's page. Azure OpenAI saves its resource endpoint with the key, and its
// custom models are deployment names the API checks against that endpoint. It
// can also sign in with Microsoft Entra ID instead of a key: the organization's
// own app, or this deployment's identity when the operator offers it.

/** Whether `slug` is an upstream id this provider accepts. */
function upstreamIdValid(providerKind: ProviderKind, slug: string): boolean {
  if (providerKind === "openai" || providerKind === "azure_openai") {
    // An exact OpenAI model or Azure deployment name: no surrounding whitespace to trim away.
    return slug.trim() === slug && DirectModelName.safeParse(slug).success;
  }
  return (
    slug.length <= WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH && /^[!-{}-~]+$/.test(slug)
  );
}

export function useOrganizationProviderConnection({
  organizationId,
  providerKind,
  client,
  enabled = true,
  catalogConnection,
  azureDeploymentIdentity = false,
}: {
  organizationId: string;
  providerKind: ProviderKind;
  client: OpenGeniBrowserClient;
  enabled?: boolean;
  catalogConnection?: { connected: boolean; loaded: boolean; error: Error | null };
  /** Azure OpenAI: the deployment offers its own identity to organizations. */
  azureDeploymentIdentity?: boolean;
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
    endpoint: string | undefined;
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
  const noun = meta.customModelNoun ?? "model";

  const azure = providerKind === "azure_openai";
  // The organization's own OpenAI or Azure key: each model is checked with it
  // before it is saved, so models can only be added once it is connected.
  const direct = azure || providerKind === "openai";
  const slugValid = upstreamIdValid(providerKind, slug);
  const slugExists = models.some((model) => model.upstreamModelId === slug);
  const slugInvalid = slug.length > 0 && (!slugValid || slugExists);
  const slugHelp =
    providerKind === "openai"
      ? slugExists
        ? "That model is already added."
        : slug && !slugValid
          ? "Use the exact model ID: letters, numbers, dots, underscores or hyphens."
          : connected
            ? "Enter the exact model ID, as OpenAI lists it."
            : "Models can be added after OpenAI is connected."
      : azure
        ? slugExists
          ? "That deployment is already added."
          : slug && !slugValid
            ? "Use the exact deployment name: letters, numbers, dots, underscores or hyphens."
            : connected
              ? "Enter the exact deployment name from your Azure OpenAI resource."
              : "Deployments can be added after Azure OpenAI is connected."
        : slugExists
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

  async function saveKey(
    apiKey: string,
    options?: {
      endpoint?: string | undefined;
      authentication?: OrganizationModelProviderEntraAuthentication | undefined;
    },
  ): Promise<boolean> {
    const key = apiKey.trim();
    const endpoint = azure ? options?.endpoint?.trim() : undefined;
    const authentication = azure ? options?.authentication : undefined;
    if (!epoch.active || !enabled || catalogConnection || connectionBusy) return false;
    if (!key && !authentication) return false;
    if (azure && !endpoint) return false;
    const write = sharedQueryWriter(client);
    const credentialIdentity = authentication ? JSON.stringify(authentication) : key;
    const version = connection?.version ?? 0;
    const pending = pendingSaveRef.current;
    // A changed endpoint is a different request, so it gets its own operation.
    const operationId =
      pending?.key === credentialIdentity &&
      pending.endpoint === endpoint &&
      pending.version === version
        ? pending.operationId
        : crypto.randomUUID();
    pendingSaveRef.current = { key: credentialIdentity, endpoint, version, operationId };
    setConnectionBusy(true);
    const journey = beginIntegrationConnect(
      modelConnectionClass(providerKind) ?? "other",
      authentication ? "custom" : "api_key",
    );
    const mutate = () =>
      client.upsertOrganizationModelProviderConnection(organizationId, providerKind, {
        operationId,
        expectedVersion: version,
        ...(authentication ? { authentication } : { apiKey: key }),
        ...(endpoint ? { endpoint } : {}),
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
      !upstreamIdValid(providerKind, submittedSlug) ||
      models.some((model) => model.upstreamModelId === submittedSlug) ||
      // OpenAI and Azure check each model with the connected key.
      (direct && !connected)
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
      toast.success(`${meta.title} ${noun} added`, {
        description: connected
          ? "It can now appear in shared-workspace model pickers."
          : `It will become selectable after ${meta.shortName} is connected.`,
      });
    };
    try {
      let saved: CustomModel;
      try {
        saved = await mutate();
      } catch (error) {
        // A model the API refused was checked with OpenAI or Azure; asking
        // again would only repeat that check. Retry only a lost response.
        if (direct && error instanceof OpenGeniApiError && !error.outcomeUnknown) throw error;
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
        toast.error(`Couldn't add ${meta.title} ${noun}`, {
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
      toast.success(`${meta.title} ${noun} removed`);
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
      toast.error(`Couldn't remove ${meta.title} ${noun}`, {
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
    endpoint: connection?.status === "active" ? connection.endpoint : undefined,
    authMethod: connection?.status === "active" ? connection.authMethod : undefined,
    signInMethods: azure
      ? ([
          "api_key",
          "entra_client_secret",
          ...(azureDeploymentIdentity ? (["entra_deployment_identity"] as const) : []),
        ] satisfies OrganizationModelProviderAuthMethod[])
      : undefined,
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
