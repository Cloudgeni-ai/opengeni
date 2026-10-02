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
import { userErrorText } from "@/lib/api-error";

// Organization API-key providers (Vercel AI Gateway, OpenRouter) shared with
// the organization's workspaces. Returns the same view as the workspace hook,
// so Organization settings > Models reuses the row and the provider's page.

/** A failed read, kept whole so the page can show advice and its API facts. */
function readError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useOrganizationProviderConnection({
  organizationId,
  providerKind,
  client,
  enabled = true,
}: {
  organizationId: string;
  providerKind: ProviderKind;
  client: OpenGeniBrowserClient;
  enabled?: boolean;
}): ProviderConnectionView {
  const meta = ORGANIZATION_PROVIDER_META[providerKind];
  const [connection, setConnection] = useState<Connection | null>(null);
  const [models, setModels] = useState<CustomModel[]>([]);
  const [slug, setSlug] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const [modelsError, setModelsError] = useState<Error | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemovalState, setPendingRemovalState] = useState<CustomModel | null>(null);
  const activeRef = useRef(true);
  const connectionGenerationRef = useRef(0);
  const modelsGenerationRef = useRef(0);
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
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const connected = connection?.status === "active";

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
    if (!enabled) return undefined;
    const generation = ++connectionGenerationRef.current;
    try {
      const result = await client.getOrganizationModelProviderConnection(
        organizationId,
        providerKind,
      );
      if (!activeRef.current || generation !== connectionGenerationRef.current) return undefined;
      setConnection(result);
      setConnectionError(null);
      setLoaded(true);
      return result;
    } catch (error) {
      if (!activeRef.current || generation !== connectionGenerationRef.current) return undefined;
      setConnectionError(readError(error));
      setLoaded(true);
      return undefined;
    }
  }, [client, organizationId, providerKind, enabled]);

  const claudeUsage = useClaudeUsage({
    client,
    scope: "organization",
    scopeId: organizationId,
    enabled: enabled && providerKind === "claude_subscription",
    connected,
    credentialVersion: connection?.version,
    canManage: true,
    onCredentialChanged: refreshConnection,
  });

  const refreshModels = useCallback(async (): Promise<CustomModel[] | undefined> => {
    if (!enabled) return undefined;
    const generation = ++modelsGenerationRef.current;
    try {
      const result = await client.listOrganizationProviderCustomModels(
        organizationId,
        providerKind,
      );
      if (!activeRef.current || generation !== modelsGenerationRef.current) return undefined;
      setModels(result.models);
      setModelsError(null);
      setModelsLoaded(true);
      return result.models;
    } catch (error) {
      if (!activeRef.current || generation !== modelsGenerationRef.current) return undefined;
      setModelsError(readError(error));
      setModelsLoaded(true);
      return undefined;
    }
  }, [client, organizationId, providerKind, enabled]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshConnection(), refreshModels()]);
  }, [refreshConnection, refreshModels]);

  useEffect(() => void refresh(), [refresh]);

  async function saveKey(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!key || connectionBusy) return false;
    const credentialIdentity = key;
    const version = connection?.version ?? 0;
    const pending = pendingSaveRef.current;
    const operationId =
      pending?.key === credentialIdentity && pending.version === version
        ? pending.operationId
        : crypto.randomUUID();
    pendingSaveRef.current = { key: credentialIdentity, version, operationId };
    connectionGenerationRef.current += 1;
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
      pendingSaveRef.current = null;
      setConnection(saved);
      setConnectionError(null);
      setLoaded(true);
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
      await refreshConnection();
      toast.error(`Couldn't connect ${meta.title}`, {
        description: userErrorText(finalError),
      });
      return false;
    } finally {
      if (activeRef.current) setConnectionBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!connection || connection.status !== "active") return true;
    connectionGenerationRef.current += 1;
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
      setConnection(revoked);
      setConnectionError(null);
      setLoaded(true);
      toast.success(`${meta.title} disconnected`);
      return true;
    } catch (error) {
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
      if (activeRef.current) setConnectionBusy(false);
    }
  }

  async function addModel(upstreamModelId?: string): Promise<void> {
    const submittedSlug = upstreamModelId ?? slug;
    if (
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
    modelsGenerationRef.current += 1;
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
      pendingCreateRef.current = null;
      setModels((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== saved.id && candidate.upstreamModelId !== saved.upstreamModelId,
        ),
        saved,
      ]);
      setModelsError(null);
      setModelsLoaded(true);
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
      const reconciled = await refreshModels();
      const committed = reconciled?.find((model) => model.upstreamModelId === submittedSlug);
      if (committed) commit(committed);
      else
        toast.error(`Couldn't add ${meta.title} model`, {
          description: userErrorText(error),
        });
    } finally {
      if (activeRef.current) {
        setModelBusy(false);
        modelInputRef.current?.focus();
      }
    }
  }

  async function removeModel(model: CustomModel): Promise<boolean> {
    setRemovingId(model.id);
    modelsGenerationRef.current += 1;
    const operationId = pendingDeletesRef.current.get(model.id) ?? crypto.randomUUID();
    pendingDeletesRef.current.set(model.id, operationId);
    const mutate = () =>
      client.deleteOrganizationProviderCustomModel(organizationId, providerKind, model.id, {
        operationId,
        expectedVersion: model.version,
      });
    const commit = () => {
      pendingDeletesRef.current.delete(model.id);
      setModels((current) => current.filter((candidate) => candidate.id !== model.id));
      setModelsError(null);
      setModelsLoaded(true);
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
      if (activeRef.current) setRemovingId(null);
    }
  }

  return {
    config: meta,
    scopeLabel: "Organization",
    organization: true,
    accessTarget: { client, organizationId, kind: providerKind, connectionId: "current" },
    canManageConnection: enabled,
    canManageCustomModels: enabled,
    connected,
    settled: !enabled || (loaded && modelsLoaded),
    hidden: !enabled,
    error: connectionError,
    customModelsError: modelsError,
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
