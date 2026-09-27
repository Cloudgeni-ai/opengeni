import { trackModelConnection } from "@/lib/analytics-observer";

import type { ConnectionMetadata, WorkspaceGatewayCustomModel } from "@opengeni/sdk";
import { WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH } from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  BuildingIcon,
  FolderIcon,
  KeyRoundIcon,
  Loader2Icon,
  MinusCircleIcon,
  PlusIcon,
  UnplugIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import {
  ConnectionAccessFormPage,
  ConnectionAccessRows,
  useConnectionAccess,
  type ConnectionAccessTarget,
} from "@/components/connection-access-settings";
import { ModelsFormPage, MoreMenu, ProviderTile, RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow } from "@/components/ui/list-row";
import { SecretInput } from "@/components/ui/secret-field";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";

// Workspace API-key providers (Vercel AI Gateway, OpenRouter) for Settings >
// Models: the connection and custom models (useProviderConnection), the list
// row, the provider's own page, the Replace key prompt and the Connect page.

type WorkspaceProviderCustomModel = WorkspaceGatewayCustomModel;

type CustomModelCreateRequest = {
  operationId: string;
  upstreamModelId: string;
};

type CustomModelDeleteRequest = {
  expectedVersion: number;
  operationId: string;
};

type ProviderConnectionConfig = {
  id: "vercel-ai-gateway" | "openrouter";
  providerDomain: string;
  credentialRole: string;
  credentialLabel: string;
  readinessProvider: string;
  title: string;
  provider: "vercel" | "openrouter";
  billedTo: string;
  analyticsAction: string;
  /** One sentence under the name, for the not-connected row and the Connect page. */
  summary: string;
  /** Where to get a key. */
  keyHelp: string;
  billingDescription: string;
  connectionManagerDescription: string;
  keyAriaLabel: string;
  keyPlaceholder: (connected: boolean) => string;
  customModelsHeading: string;
  customModelsDescription: string;
  customModelInputAriaLabel: string;
  customModelPlaceholder: string;
  customModelConnectedHelp: string;
  customModelDisconnectedHelp: string;
  emptyCustomModelsDescription: string;
  readyModelDescription: string;
  waitingModelDescription: string;
  unavailableModelDescription: string;
  modelToastName: string;
  listCustomModels: (
    client: OpenGeniBrowserClient,
    workspaceId: string,
  ) => Promise<{ models: WorkspaceProviderCustomModel[] }>;
  createCustomModel: (
    client: OpenGeniBrowserClient,
    workspaceId: string,
    request: CustomModelCreateRequest,
  ) => Promise<WorkspaceProviderCustomModel>;
  deleteCustomModel: (
    client: OpenGeniBrowserClient,
    workspaceId: string,
    customModelId: string,
    request: CustomModelDeleteRequest,
  ) => Promise<void>;
};

const GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
const GATEWAY_ROLE = "vercel_ai_gateway";
const OPENROUTER_DOMAIN = "openrouter.ai";
const OPENROUTER_ROLE = "openrouter";

const VERCEL_AI_GATEWAY_CONFIG: ProviderConnectionConfig = {
  id: "vercel-ai-gateway",
  providerDomain: GATEWAY_DOMAIN,
  credentialRole: GATEWAY_ROLE,
  credentialLabel: "Vercel AI Gateway",
  readinessProvider: "workspace-gateway",
  title: "Vercel AI Gateway",
  provider: "vercel",
  billedTo: "Your Vercel account",
  analyticsAction: "connect_ai_gateway",
  summary: "Use models through your Vercel account, billed to Vercel.",
  keyHelp: "Create one in Vercel under AI Gateway, then API keys.",
  billingDescription:
    "Use models through this workspace's Vercel account. The workspace's Vercel account is billed directly instead of using OpenGeni credits.",
  connectionManagerDescription:
    "Members with connection-management access manage this Vercel AI Gateway connection.",
  keyAriaLabel: "Vercel AI Gateway key",
  keyPlaceholder: (connected) =>
    connected ? "Replace Vercel AI Gateway key" : "Vercel AI Gateway key",
  customModelsHeading: "Custom models",
  customModelsDescription:
    "Add an exact Vercel model slug. OpenGeni uses the Gateway's routing and does not inspect or pin a provider for custom entries.",
  customModelInputAriaLabel: "Vercel AI Gateway model slug",
  customModelPlaceholder: "anthropic/claude-sonnet-4.6",
  customModelConnectedHelp: "The model becomes selectable when workspace policy allows it.",
  customModelDisconnectedHelp:
    "You can configure models now; they become selectable after you connect the Gateway.",
  emptyCustomModelsDescription:
    "No custom model slugs yet. The curated Gateway models remain available separately.",
  readyModelDescription: "Ready through Your Gateway",
  waitingModelDescription: "Waiting for a Gateway connection",
  unavailableModelDescription: "Gateway connection status unavailable",
  modelToastName: "Gateway model",
  listCustomModels: (client, workspaceId) => client.listWorkspaceGatewayCustomModels(workspaceId),
  createCustomModel: (client, workspaceId, request) =>
    client.createWorkspaceGatewayCustomModel(workspaceId, request),
  deleteCustomModel: (client, workspaceId, customModelId, request) =>
    client.deleteWorkspaceGatewayCustomModel(workspaceId, customModelId, request),
};

const OPENROUTER_CONFIG: ProviderConnectionConfig = {
  id: "openrouter",
  providerDomain: OPENROUTER_DOMAIN,
  credentialRole: OPENROUTER_ROLE,
  credentialLabel: "OpenRouter",
  readinessProvider: "workspace-openrouter",
  title: "OpenRouter",
  provider: "openrouter",
  billedTo: "Your OpenRouter account",
  analyticsAction: "connect_openrouter",
  summary: "Use models through your OpenRouter account, billed to OpenRouter.",
  keyHelp: "Create one on openrouter.ai under Keys.",
  billingDescription:
    "Use models through this workspace's OpenRouter account. The workspace's OpenRouter account is billed directly. This is separate from deployment-provided OpenRouter models, including free models and models funded by deployment credits.",
  connectionManagerDescription:
    "Members with connection-management access manage this workspace OpenRouter connection.",
  keyAriaLabel: "OpenRouter API key",
  keyPlaceholder: (connected) => (connected ? "Replace OpenRouter API key" : "OpenRouter API key"),
  customModelsHeading: "Custom models",
  customModelsDescription:
    "Add an exact OpenRouter model slug for this workspace account. Deployment-provided OpenRouter models remain separate.",
  customModelInputAriaLabel: "OpenRouter model slug",
  customModelPlaceholder: "anthropic/claude-sonnet-4.6",
  customModelConnectedHelp: "The model becomes selectable when workspace policy allows it.",
  customModelDisconnectedHelp:
    "You can configure models now; they become selectable after you connect OpenRouter.",
  emptyCustomModelsDescription:
    "No custom model slugs yet. Deployment-provided OpenRouter models remain available separately.",
  readyModelDescription: "Ready through workspace OpenRouter",
  waitingModelDescription: "Waiting for an OpenRouter connection",
  unavailableModelDescription: "OpenRouter connection status unavailable",
  modelToastName: "OpenRouter model",
  listCustomModels: (client, workspaceId) =>
    client.listWorkspaceOpenRouterCustomModels(workspaceId),
  createCustomModel: (client, workspaceId, request) =>
    client.createWorkspaceOpenRouterCustomModel(workspaceId, request),
  deleteCustomModel: (client, workspaceId, customModelId, request) =>
    client.deleteWorkspaceOpenRouterCustomModel(workspaceId, customModelId, request),
};

function isProviderConnection(
  connection: ConnectionMetadata,
  config: ProviderConnectionConfig,
): boolean {
  return (
    connection.subjectId === null &&
    connection.providerDomain === config.providerDomain &&
    connection.kind === "api_key" &&
    connection.metadata.credentialRole === config.credentialRole
  );
}

export type ProviderConnectionProps = {
  workspaceId: string;
  canManageConnection: boolean;
  canManageCustomModels: boolean;
  onConnectionChange?: (() => void) | undefined;
};

export const PROVIDER_CONNECTION_CONFIGS = {
  vercel: VERCEL_AI_GATEWAY_CONFIG,
  openrouter: OPENROUTER_CONFIG,
} as const;

export type ProviderConnection = ProviderConnectionView;

/** Presentation of an API-key provider, shared by workspace and organization scope. */
export type ProviderPresentation = Pick<
  ProviderConnectionConfig,
  | "title"
  | "provider"
  | "summary"
  | "keyHelp"
  | "keyAriaLabel"
  | "customModelsHeading"
  | "customModelsDescription"
  | "customModelInputAriaLabel"
  | "customModelPlaceholder"
  | "emptyCustomModelsDescription"
  | "readyModelDescription"
  | "waitingModelDescription"
  | "unavailableModelDescription"
  | "modelToastName"
  | "connectionManagerDescription"
> & {
  /** Where the key is billed, for the page's aside. */
  billedTo: string;
  analyticsAction?: string | undefined;
};

export interface CustomModelLike {
  id: string;
  upstreamModelId: string;
  version: number;
  label?: string | null | undefined;
}

/**
 * Everything the row and the page need from an API-key provider. The workspace
 * hook (useProviderConnection) and the organization hook
 * (useOrganizationProviderConnection) both return it.
 */
export interface ProviderConnectionView {
  config: ProviderPresentation;
  /** "Workspace" or "Organization": who owns the key. */
  scopeLabel: string;
  organization: boolean;
  accessTarget: ConnectionAccessTarget;
  canManageConnection: boolean;
  canManageCustomModels: boolean;
  connected: boolean;
  settled: boolean;
  hidden: boolean;
  error: string | null;
  customModelsError: string | null;
  customModels: readonly CustomModelLike[];
  customModelsLoaded: boolean;
  busy: boolean;
  modelSlug: string;
  modelBusy: boolean;
  modelSlugValid: boolean;
  modelSlugExists: boolean;
  modelSlugInvalid: boolean;
  modelSlugHelp: string;
  removingModelId: string | null;
  modelPendingRemoval: CustomModelLike | null;
  modelInputRef: RefObject<HTMLInputElement | null>;
  addWorkflowRef: RefObject<HTMLDivElement | null>;
  removeButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  removeFocusTargetRef: RefObject<HTMLElement | null>;
  restoreRemovalFocusRef: RefObject<boolean>;
  setModelSlug(value: string): void;
  setModelPendingRemoval(model: CustomModelLike | null): void;
  refreshConnection(): Promise<unknown>;
  refreshCustomModels(): Promise<unknown>;
  /** Connects or replaces the key. Resolves true once it's saved; toasts on failure. */
  saveKey(apiKey: string): Promise<boolean>;
  /** Resolves true once no active key remains; toasts either way. */
  disconnect(): Promise<boolean>;
  addCustomModel(): Promise<void>;
  removeCustomModel(model: CustomModelLike): Promise<boolean>;
}

export function useProviderConnection(
  props: ProviderConnectionProps & {
    client: OpenGeniBrowserClient;
    config: ProviderConnectionConfig;
  },
): ProviderConnectionView & {
  config: ProviderConnectionConfig;
  connection: ConnectionMetadata | null;
  loaded: boolean;
} {
  const client = props.client;
  const config = props.config;
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [readOnlyConnected, setReadOnlyConnected] = useState(false);
  const [customModels, setCustomModels] = useState<WorkspaceProviderCustomModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [customModelsLoaded, setCustomModelsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelSlug, setModelSlug] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [removingModelId, setRemovingModelId] = useState<string | null>(null);
  const [modelPendingRemoval, setModelPendingRemoval] =
    useState<WorkspaceProviderCustomModel | null>(null);
  const activeRef = useRef(true);
  const connectionRequestGenerationRef = useRef(0);
  const customModelsRequestGenerationRef = useRef(0);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const addWorkflowRef = useRef<HTMLDivElement | null>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const removeFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreModelInputFocusRef = useRef(false);
  const restoreRemovalFocusRef = useRef(false);
  const pendingModelCreateRef = useRef<{
    upstreamModelId: string;
    operationId: string;
  } | null>(null);
  const pendingModelDeleteOperationsRef = useRef(new Map<string, string>());

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const connection = useMemo(() => {
    const providerConnections = connections.filter((candidate) =>
      isProviderConnection(candidate, config),
    );
    return (
      providerConnections.find((candidate) => candidate.status === "active") ??
      providerConnections[0] ??
      null
    );
  }, [config, connections]);
  const connected = props.canManageConnection ? connection?.status === "active" : readOnlyConnected;
  const modelSlugValid =
    modelSlug.length <= WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH &&
    /^[!-{}-~]+$/.test(modelSlug);
  const modelSlugExists = customModels.some((model) => model.upstreamModelId === modelSlug);
  const modelSlugInvalid = modelSlug.length > 0 && (!modelSlugValid || modelSlugExists);
  const modelSlugHelp = modelSlugExists
    ? "That slug is already configured for this workspace."
    : modelSlug && !modelSlugValid
      ? "Use the exact printable slug with no spaces or |."
      : connected
        ? config.customModelConnectedHelp
        : config.customModelDisconnectedHelp;

  const refreshCustomModels = useCallback(async (): Promise<
    WorkspaceProviderCustomModel[] | null
  > => {
    const requestGeneration = ++customModelsRequestGenerationRef.current;
    try {
      const result = await config.listCustomModels(client, props.workspaceId);
      if (!activeRef.current || requestGeneration !== customModelsRequestGenerationRef.current) {
        return null;
      }
      setCustomModels(result.models);
      setCustomModelsError(null);
      setCustomModelsLoaded(true);
      return result.models;
    } catch (caught) {
      if (!activeRef.current || requestGeneration !== customModelsRequestGenerationRef.current) {
        return null;
      }
      setCustomModelsError(caught instanceof Error ? caught.message : String(caught));
      setCustomModelsLoaded(true);
      return null;
    }
  }, [client, config, props.workspaceId]);

  const refreshConnection = useCallback(async (): Promise<ConnectionMetadata[] | null> => {
    const requestGeneration = ++connectionRequestGenerationRef.current;
    try {
      if (props.canManageConnection) {
        const result = await client.listConnections(props.workspaceId);
        if (!activeRef.current || requestGeneration !== connectionRequestGenerationRef.current) {
          return null;
        }
        setConnections(result);
        setError(null);
        setLoaded(true);
        return result;
      }
      const result = await client.getWorkspaceModelCatalog(props.workspaceId);
      if (!activeRef.current || requestGeneration !== connectionRequestGenerationRef.current) {
        return null;
      }
      setReadOnlyConnected(
        result.models.some(
          (model) =>
            model.provider === config.readinessProvider &&
            model.credentialReadiness.status === "ready",
        ),
      );
      setError(null);
      setLoaded(true);
      return [];
    } catch (caught) {
      if (!activeRef.current || requestGeneration !== connectionRequestGenerationRef.current) {
        return null;
      }
      if (props.canManageConnection) setConnections([]);
      setReadOnlyConnected(false);
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoaded(true);
      return null;
    }
  }, [client, config.readinessProvider, props.canManageConnection, props.workspaceId]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshConnection(), refreshCustomModels()]);
  }, [refreshConnection, refreshCustomModels]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (modelBusy || !restoreModelInputFocusRef.current) return;
    restoreModelInputFocusRef.current = false;
    const activeElement = document.activeElement;
    if (
      activeElement === null ||
      activeElement === document.body ||
      (activeElement instanceof HTMLElement && addWorkflowRef.current?.contains(activeElement))
    ) {
      modelInputRef.current?.focus();
    }
  }, [modelBusy]);

  useEffect(() => {
    if (modelPendingRemoval !== null || !restoreRemovalFocusRef.current) return;
    restoreRemovalFocusRef.current = false;
    const target = removeFocusTargetRef.current;
    if (target?.isConnected) target.focus();
    else modelInputRef.current?.focus();
  }, [customModels, modelPendingRemoval]);

  /** Connects or replaces the key. Resolves true once it's saved; toasts on failure. */
  async function saveKey(apiKey: string): Promise<boolean> {
    const value = apiKey.trim();
    if (!value) return false;
    const recordOutcome = trackModelConnection(
      config.id === "openrouter" ? "openrouter" : "ai-gateway",
      props.workspaceId,
    );
    const operationId = crypto.randomUUID();
    connectionRequestGenerationRef.current += 1;
    setBusy(true);
    const metadata = {
      credentialRole: config.credentialRole,
      credentialLabel: config.credentialLabel,
    };
    const saveConnection = async () =>
      connection && connection.status !== "revoked"
        ? await client.updateConnection(props.workspaceId, connection.id, {
            status: "active",
            credential: { apiKey: value },
            metadata,
            expectedVersion: connection.version,
            operationId,
          })
        : await client.createConnection(props.workspaceId, {
            providerDomain: config.providerDomain,
            kind: "api_key",
            subjectId: null,
            credential: { apiKey: value },
            grantedScopes: [],
            metadata,
            operationId,
          });
    const commitSavedConnection = (saved: ConnectionMetadata) => {
      recordOutcome("connected");
      connectionRequestGenerationRef.current += 1;
      setConnections((current) => [
        saved,
        ...current.filter((item) => !isProviderConnection(item, config)),
      ]);
      setError(null);
      setLoaded(true);
      props.onConnectionChange?.();
      toast.success(`${config.credentialLabel} connected`);
    };
    try {
      const saved = await saveConnection();
      if (!activeRef.current) return false;
      commitSavedConnection(saved);
      return true;
    } catch (caught) {
      if (!activeRef.current) return false;
      let finalError = caught;
      const outcomeUnknown =
        caught instanceof OpenGeniApiError ? caught.outcomeUnknown : caught instanceof Error;
      if (outcomeUnknown) {
        try {
          const replayed = await saveConnection();
          if (!activeRef.current) return false;
          commitSavedConnection(replayed);
          return true;
        } catch (retryError) {
          finalError = retryError;
        }
      }
      await refreshConnection();
      if (!activeRef.current) return false;
      recordOutcome("outcome_unknown");
      toast.error(`Couldn't save ${config.credentialLabel} key`, {
        description: finalError instanceof Error ? finalError.message : String(finalError),
      });
      return false;
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  /** Resolves true once no active key remains; toasts either way. */
  async function disconnect(): Promise<boolean> {
    if (!connection) return false;
    connectionRequestGenerationRef.current += 1;
    setBusy(true);
    try {
      await client.deleteConnection(props.workspaceId, connection.id);
      if (!activeRef.current) return false;
      const reconciled = await refreshConnection();
      if (!activeRef.current) return false;
      const committed =
        reconciled !== null &&
        !reconciled.some(
          (candidate) => isProviderConnection(candidate, config) && candidate.status === "active",
        );
      if (!committed) {
        toast.error(`Couldn't confirm ${config.credentialLabel} disconnect`, {
          description:
            reconciled === null
              ? "Reload the page before trying again."
              : `A newer ${config.credentialLabel} key is still connected.`,
        });
        return false;
      }
      props.onConnectionChange?.();
      toast.success(`${config.credentialLabel} disconnected`);
      return true;
    } catch (caught) {
      if (!activeRef.current) return false;
      const reconciled = await refreshConnection();
      if (!activeRef.current) return false;
      const committed =
        reconciled !== null &&
        !reconciled.some(
          (candidate) => isProviderConnection(candidate, config) && candidate.status === "active",
        );
      if (committed) {
        props.onConnectionChange?.();
        toast.success(`${config.credentialLabel} disconnected`);
        return true;
      }
      toast.error(`Couldn't disconnect ${config.credentialLabel}`, {
        description: caught instanceof Error ? caught.message : String(caught),
      });
      return false;
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  async function addCustomModel() {
    if (modelBusy || !modelSlugValid || modelSlugExists) return;
    const submittedSlug = modelSlug;
    const pending = pendingModelCreateRef.current;
    const operationId =
      pending?.upstreamModelId === submittedSlug ? pending.operationId : crypto.randomUUID();
    pendingModelCreateRef.current = {
      upstreamModelId: submittedSlug,
      operationId,
    };
    customModelsRequestGenerationRef.current += 1;
    restoreModelInputFocusRef.current = true;
    setModelBusy(true);
    const confirmAdded = (saved: WorkspaceProviderCustomModel) => {
      pendingModelCreateRef.current = null;
      setCustomModels((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== saved.id && candidate.upstreamModelId !== saved.upstreamModelId,
        ),
        saved,
      ]);
      setCustomModelsError(null);
      setCustomModelsLoaded(true);
      setModelSlug((current) => (current === submittedSlug ? "" : current));
      props.onConnectionChange?.();
      toast.success(`${config.modelToastName} added`, {
        description: connected
          ? "It can now appear in this workspace's model picker."
          : `It can be picked once ${config.credentialLabel} is connected.`,
      });
    };
    try {
      const create = () =>
        config.createCustomModel(client, props.workspaceId, {
          operationId,
          upstreamModelId: submittedSlug,
        });
      let saved: WorkspaceProviderCustomModel;
      try {
        saved = await create();
      } catch {
        saved = await create();
      }
      if (!activeRef.current) return;
      confirmAdded(saved);
    } catch (caught) {
      if (!activeRef.current) return;
      const reconciled = await refreshCustomModels();
      if (!activeRef.current) return;
      const committed = reconciled?.find(
        (candidate) => candidate.upstreamModelId === submittedSlug,
      );
      if (committed) {
        confirmAdded(committed);
        return;
      }
      toast.error(`Couldn't confirm ${config.modelToastName} add`, {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (activeRef.current) setModelBusy(false);
    }
  }

  async function removeCustomModel(model: WorkspaceProviderCustomModel): Promise<boolean> {
    const modelIndex = customModels.findIndex((candidate) => candidate.id === model.id);
    const focusModelId =
      customModels[modelIndex + 1]?.id ?? customModels[modelIndex - 1]?.id ?? null;
    setRemovingModelId(model.id);
    const operationId =
      pendingModelDeleteOperationsRef.current.get(model.id) ?? crypto.randomUUID();
    pendingModelDeleteOperationsRef.current.set(model.id, operationId);
    customModelsRequestGenerationRef.current += 1;
    const confirmRemoved = () => {
      pendingModelDeleteOperationsRef.current.delete(model.id);
      setCustomModels((current) => current.filter((candidate) => candidate.id !== model.id));
      setCustomModelsError(null);
      setCustomModelsLoaded(true);
      removeFocusTargetRef.current = focusModelId
        ? (removeButtonRefs.current.get(focusModelId) ?? modelInputRef.current)
        : modelInputRef.current;
      props.onConnectionChange?.();
      toast.success(`${config.modelToastName} removed`);
    };
    try {
      const remove = () =>
        config.deleteCustomModel(client, props.workspaceId, model.id, {
          expectedVersion: model.version,
          operationId,
        });
      try {
        await remove();
      } catch {
        await remove();
      }
      if (!activeRef.current) return true;
      confirmRemoved();
      return true;
    } catch (caught) {
      if (!activeRef.current) return false;
      const reconciled = await refreshCustomModels();
      if (!activeRef.current) return false;
      if (reconciled !== null) {
        const originalStillPresent = reconciled.some((candidate) => candidate.id === model.id);
        if (!originalStillPresent) {
          const replacement = reconciled.find(
            (candidate) => candidate.upstreamModelId === model.upstreamModelId,
          );
          if (!replacement) {
            confirmRemoved();
            return true;
          }
          pendingModelDeleteOperationsRef.current.delete(model.id);
          setModelPendingRemoval(replacement);
        }
      }
      toast.error(`Couldn't confirm ${config.modelToastName} removal`, {
        description: caught instanceof Error ? caught.message : String(caught),
      });
      return false;
    } finally {
      if (activeRef.current) setRemovingModelId(null);
    }
  }

  const settled = loaded && customModelsLoaded;
  // Hide an empty provider only when the caller can manage neither the
  // credential nor custom models. Read-only members still see an existing
  // connection or catalog, and either authority can reach its own controls.
  const hidden =
    !props.canManageConnection &&
    !props.canManageCustomModels &&
    (!settled || (!error && !customModelsError && !connected && customModels.length === 0));

  return {
    config,
    scopeLabel: "Workspace",
    organization: false,
    accessTarget: {
      client,
      workspaceId: props.workspaceId,
      kind: config.credentialRole === "openrouter" ? "openrouter" : "vercel_gateway",
      connectionId: "current",
    },
    canManageConnection: props.canManageConnection,
    canManageCustomModels: props.canManageCustomModels,
    connection,
    connected,
    loaded,
    customModelsLoaded,
    settled,
    hidden,
    error,
    customModelsError,
    customModels,
    busy,
    modelSlug,
    setModelSlug,
    modelBusy,
    modelSlugValid,
    modelSlugExists,
    modelSlugInvalid,
    modelSlugHelp,
    removingModelId,
    modelPendingRemoval,
    modelInputRef,
    addWorkflowRef,
    removeButtonRefs,
    removeFocusTargetRef,
    restoreRemovalFocusRef,
    refreshConnection,
    refreshCustomModels,
    saveKey,
    disconnect,
    addCustomModel,
    removeCustomModel: (model) =>
      removeCustomModel(
        customModels.find((candidate) => candidate.id === model.id) ??
          (model as WorkspaceProviderCustomModel),
      ),
    setModelPendingRemoval: (model) =>
      setModelPendingRemoval(model as WorkspaceProviderCustomModel | null),
  };
}

/** Status of the provider, in words, for the row and the page header. */
export function providerStatus(state: ProviderConnection): {
  status: "connected" | "not_connected" | "unavailable" | "loading";
  label: string;
} {
  if (!state.settled) return { status: "loading", label: "Loading…" };
  if (state.error || state.customModelsError)
    return { status: "unavailable", label: "Unavailable" };
  return state.connected
    ? { status: "connected", label: "Connected" }
    : { status: "not_connected", label: "Not connected" };
}

/* ----------------------------------------------------------------------------
   The list row.
   -------------------------------------------------------------------------- */

export function ProviderConnectionRow({
  state,
  onOpen,
  onConnect,
}: {
  state: ProviderConnection;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const { config } = state;
  const status = providerStatus(state);
  const models = state.customModels.length;
  const modelsLabel =
    models === 0 ? null : models === 1 ? "1 custom model" : `${models} custom models`;
  if (status.status === "loading") {
    return (
      <ListRow
        leading={<ProviderTile provider={config.provider} />}
        title={config.title}
        description="Loading…"
        indicator="loading"
      />
    );
  }
  // Nothing to open yet: one quiet row with Connect.
  if (status.status === "not_connected" && models === 0 && state.canManageConnection) {
    return (
      <ListRow
        leading={<ProviderTile provider={config.provider} />}
        title={config.title}
        description={config.summary}
        control={
          <RowButton onClick={onConnect} aria-label={`Connect ${config.title}`}>
            Connect
          </RowButton>
        }
      />
    );
  }
  return (
    <ListRow
      leading={<ProviderTile provider={config.provider} />}
      title={config.title}
      meta={[status.status === "connected" ? "API key" : status.label, modelsLabel]}
      indicator={
        status.status === "unavailable" ? { kind: "unavailable", label: "Couldn't load" } : "open"
      }
      onOpen={onOpen}
    />
  );
}

/* ----------------------------------------------------------------------------
   The provider's page.
   -------------------------------------------------------------------------- */

function CustomModels({ state }: { state: ProviderConnection }) {
  const { config } = state;
  const modelSlugHelpId = useId();
  const readiness = state.error
    ? config.unavailableModelDescription
    : state.connected
      ? config.readyModelDescription
      : config.waitingModelDescription;
  return (
    <DetailSection title={config.customModelsHeading} description={config.customModelsDescription}>
      <div className="flex min-w-0 flex-col gap-4">
        {state.canManageCustomModels ? (
          <div ref={state.addWorkflowRef} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 gap-2">
              <TextInput
                ref={state.modelInputRef}
                mono
                value={state.modelSlug}
                onChange={(event) => state.setModelSlug(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !state.modelBusy) {
                    event.preventDefault();
                    void state.addCustomModel();
                  }
                }}
                disabled={state.modelBusy}
                className="min-w-0 flex-1"
                placeholder={config.customModelPlaceholder}
                aria-label={config.customModelInputAriaLabel}
                aria-describedby={modelSlugHelpId}
                aria-invalid={state.modelSlugInvalid || undefined}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                disabled={state.modelBusy || !state.modelSlugValid || state.modelSlugExists}
                onClick={() => void state.addCustomModel()}
                className="h-9 rounded-[10px] pointer-coarse:h-11"
              >
                {state.modelBusy ? (
                  <Loader2Icon aria-hidden="true" className="motion-safe:animate-spin" />
                ) : (
                  <PlusIcon aria-hidden="true" />
                )}
                Add model
              </Button>
            </div>
            <p
              id={modelSlugHelpId}
              className={
                state.modelSlugInvalid
                  ? "text-xs leading-4.5 text-danger"
                  : "text-xs leading-4.5 text-fg-muted"
              }
              aria-live="polite"
              aria-atomic="true"
            >
              {state.modelSlugHelp}
            </p>
          </div>
        ) : null}

        {state.customModelsError ? (
          <ErrorMessage
            title="Couldn't load custom models."
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={state.modelBusy}
                onClick={() => void state.refreshCustomModels()}
                className="rounded-[10px] pointer-coarse:h-11"
              >
                Try again
              </Button>
            }
          >
            {state.customModelsError}
          </ErrorMessage>
        ) : null}

        {state.customModelsLoaded && !state.customModelsError && state.customModels.length === 0 ? (
          <p className="text-sm text-fg-muted">{config.emptyCustomModelsDescription}</p>
        ) : null}

        {state.customModelsLoaded && !state.customModelsError && state.customModels.length > 0 ? (
          <SettingRowGroup
            role="list"
            aria-label={`Custom models on ${config.title}`}
            className="-mb-3"
          >
            {state.customModels.map((model) => (
              <SettingRow
                key={model.id}
                role="listitem"
                label={
                  <span className="font-mono text-xs font-normal">{model.upstreamModelId}</span>
                }
                description={readiness}
                control={
                  state.canManageCustomModels ? (
                    <Button
                      ref={(node) => {
                        if (node) state.removeButtonRefs.current.set(model.id, node);
                        else state.removeButtonRefs.current.delete(model.id);
                      }}
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="-mr-1.5 rounded-[10px] text-fg-subtle hover:text-danger pointer-coarse:size-11"
                      disabled={state.removingModelId !== null}
                      aria-label={`Remove ${model.upstreamModelId}`}
                      onClick={() => {
                        state.removeFocusTargetRef.current =
                          state.removeButtonRefs.current.get(model.id) ??
                          state.modelInputRef.current;
                        state.restoreRemovalFocusRef.current = true;
                        state.setModelPendingRemoval(model);
                      }}
                    >
                      {state.removingModelId === model.id ? (
                        <Loader2Icon aria-hidden="true" className="motion-safe:animate-spin" />
                      ) : (
                        <MinusCircleIcon aria-hidden="true" />
                      )}
                    </Button>
                  ) : null
                }
              />
            ))}
          </SettingRowGroup>
        ) : null}
      </div>
      <ConfirmDialog
        open={state.modelPendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) state.setModelPendingRemoval(null);
        }}
        title={
          state.modelPendingRemoval ? (
            <>
              Remove {config.modelToastName} “
              <span className="break-all">{state.modelPendingRemoval.upstreamModelId}</span>”?
            </>
          ) : (
            `Remove ${config.modelToastName}?`
          )
        }
        description="It disappears from new selections. Work already running and existing chats keep it."
        confirmLabel="Remove model"
        restoreFocusRef={state.removeFocusTargetRef}
        restoreFocusFallbackRef={state.modelInputRef}
        onConfirm={async () =>
          state.modelPendingRemoval
            ? await state.removeCustomModel(state.modelPendingRemoval)
            : false
        }
      />
    </DetailSection>
  );
}

/** Replace key: a one-field prompt. */
export function ReplaceKeyDialog({
  state,
  open,
  onOpenChange,
}: {
  state: ProviderConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const { config } = state;
  useEffect(() => {
    if (!open) setKey("");
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      leading={<ProviderTile provider={config.provider} />}
      title={`Replace the ${config.title} key`}
      description="New work uses the new key right away. Work already running finishes on the old one."
      submitLabel="Replace key"
      pendingLabel="Saving…"
      submitDisabled={!key.trim()}
      onSubmit={async () => await state.saveKey(key)}
      onSubmitted={() => onOpenChange(false)}
    >
      <Field
        label="API key"
        hint={`${config.keyHelp} It's stored encrypted and never shown again.`}
      >
        <SecretInput
          value={key}
          autoComplete="off"
          aria-label={config.keyAriaLabel}
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

export function ProviderDisconnectDialog({
  state,
  open,
  onOpenChange,
  onDisconnected,
}: {
  state: ProviderConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}) {
  const { config } = state;
  const models = state.customModels.length;
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={onOpenChange}
      title={`Disconnect ${config.title}?`}
      consequences={[
        models > 0
          ? `Models billed to this key, including ${models === 1 ? "its custom model" : `its ${models} custom models`}, stop working for new work.`
          : `Models billed to ${config.title} stop working for new work.`,
        "Work already running finishes first.",
        "The key is deleted. You'll need a new one to reconnect.",
      ]}
      confirmLabel="Disconnect"
      pendingLabel="Disconnecting…"
      onConfirm={async () => {
        const done = await state.disconnect();
        if (done) onDisconnected();
        return done;
      }}
    />
  );
}

/**
 * The provider's page: key, custom models, and (once limited) the models it
 * serves. `onBack` leaves the page; without it the page has no back link.
 */
export function ProviderConnectionPage({
  state,
  scopeName,
  onBack,
  onConnect,
  onEditAccess,
}: {
  state: ProviderConnection;
  /** The workspace's or organization's name. */
  scopeName?: string | undefined;
  onBack?: (() => void) | undefined;
  onConnect: () => void;
  onEditAccess?: (() => void) | undefined;
}) {
  const { config } = state;
  const status = providerStatus(state);
  const [replacing, setReplacing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const access = useConnectionAccess({
    ...state.accessTarget,
    enabled: state.connected && Boolean(onEditAccess),
  });
  // "Models it can serve" shows only once this key is limited; Allowed models covers the rest.
  const showAccess =
    state.connected &&
    Boolean(onEditAccess) &&
    Boolean(
      access.error ||
      (access.data && (state.organization || access.data.policy.allowedModels !== null)),
    );
  const header = (
    <DetailPageHeader
      leading={<ProviderTile provider={config.provider} />}
      title={config.title}
      chips={
        status.status === "loading" ? null : (
          <StatusBadge
            variant="outline"
            status={
              status.status === "connected"
                ? "connected"
                : status.status === "unavailable"
                  ? "unavailable"
                  : "off"
            }
          >
            {status.label}
          </StatusBadge>
        )
      }
      meta={["API key", scopeName ?? state.scopeLabel]}
      actions={
        state.canManageConnection ? (
          state.connected ? (
            <>
              <RowButton onClick={() => setReplacing(true)} disabled={state.busy}>
                Replace key
              </RowButton>
              <MoreMenu label={`More actions for ${config.title}`}>
                <DropdownMenuItem variant="destructive" onSelect={() => setDisconnecting(true)}>
                  <UnplugIcon />
                  Disconnect
                </DropdownMenuItem>
              </MoreMenu>
            </>
          ) : !state.error ? (
            <Button
              type="button"
              size="sm"
              onClick={onConnect}
              className="rounded-[10px] pointer-coarse:h-11"
            >
              Connect {config.title}
            </Button>
          ) : null
        ) : null
      }
    />
  );
  return (
    <DetailPage
      back={onBack ? { label: "Models", onClick: onBack } : undefined}
      className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
    >
      {header}
      <DetailPageBody
        aside={
          <DetailAside label={`About ${config.title}`}>
            <DetailAsideItem label="Key" icon={<KeyRoundIcon />}>
              {state.connected ? "Stored encrypted" : "No key yet"}
            </DetailAsideItem>
            <DetailAsideItem
              label="Belongs to"
              icon={state.organization ? <BuildingIcon /> : <FolderIcon />}
            >
              {scopeName ?? state.scopeLabel}
            </DetailAsideItem>
            <DetailAsideItem label="Billed to">{config.billedTo}</DetailAsideItem>
          </DetailAside>
        }
      >
        {state.error ? (
          <DetailSection>
            <ErrorMessage
              title={`Couldn't check ${config.title}.`}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void state.refreshConnection()}
                  className="rounded-[10px] pointer-coarse:h-11"
                >
                  Try again
                </Button>
              }
            >
              {state.error}
            </ErrorMessage>
          </DetailSection>
        ) : null}
        {!state.canManageConnection ? (
          <DetailSection>
            <p className="text-sm text-fg-muted">{config.connectionManagerDescription}</p>
          </DetailSection>
        ) : null}
        <CustomModels state={state} />
        {showAccess && onEditAccess ? (
          <DetailSection title="Access">
            <SettingRowGroup className="-my-3">
              <ConnectionAccessRows
                access={access}
                organization={state.organization}
                canManage={state.canManageCustomModels}
                onEdit={onEditAccess}
              />
            </SettingRowGroup>
          </DetailSection>
        ) : null}
      </DetailPageBody>
      <ReplaceKeyDialog state={state} open={replacing} onOpenChange={setReplacing} />
      <ProviderDisconnectDialog
        state={state}
        open={disconnecting}
        onOpenChange={setDisconnecting}
        onDisconnected={() => onBack?.()}
      />
    </DetailPage>
  );
}

/** The key step of Connect: one secret field, then the provider's page. */
export function ProviderConnectPage({
  state,
  onClose,
  onConnected,
  footerStart,
}: {
  state: ProviderConnection;
  onClose: () => void;
  onConnected: () => void;
  footerStart?: ReactNode;
}) {
  const { config } = state;
  const [key, setKey] = useState("");
  return (
    <ModelsFormPage
      title={`Connect ${config.title}`}
      description={config.summary}
      onClose={onClose}
      submitLabel={`Connect ${config.title}`}
      pendingLabel="Connecting…"
      submitDisabled={!key.trim() || !state.canManageConnection}
      disabledReason={
        state.canManageConnection
          ? undefined
          : "Only people who can manage connections can add a key."
      }
      footerStart={footerStart}
      onSubmit={async () => await state.saveKey(key)}
      onSubmitted={onConnected}
    >
      <FieldStack>
        <Field
          label="API key"
          hint={`${config.keyHelp} It's stored encrypted and never shown again. Connecting doesn't run a model or spend credits.`}
        >
          <SecretInput
            value={key}
            autoComplete="off"
            data-analytics-action={config.analyticsAction}
            aria-label={config.keyAriaLabel}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
      </FieldStack>
    </ModelsFormPage>
  );
}

/** What "Models it can serve" edits for this provider. */
export function ProviderAccessPage({
  state,
  onClose,
}: {
  state: ProviderConnection;
  onClose: () => void;
}) {
  const access = useConnectionAccess(state.accessTarget);
  return (
    <ConnectionAccessFormPage
      access={access}
      organization={state.organization}
      canManage={state.canManageCustomModels}
      name={state.config.title}
      onClose={onClose}
    />
  );
}

/* ----------------------------------------------------------------------------
   Standalone: the provider's page with its own data, for fixtures and places
   outside Settings > Models.
   -------------------------------------------------------------------------- */

export function AiGatewayConnectionCard(props: ProviderConnectionProps) {
  const client = useAppContext().client;
  return <AiGatewayConnectionCardWithClient key={props.workspaceId} {...props} client={client} />;
}

/** Isolated product fixture seam; production uses useProviderConnection on the Models page. */
export function AiGatewayConnectionCardWithClient(
  props: ProviderConnectionProps & { client: OpenGeniBrowserClient },
) {
  return <StandaloneProviderConnection {...props} config={VERCEL_AI_GATEWAY_CONFIG} />;
}

export function OpenRouterConnectionCard(props: ProviderConnectionProps) {
  const client = useAppContext().client;
  return <OpenRouterConnectionCardWithClient key={props.workspaceId} {...props} client={client} />;
}

/** Isolated product fixture seam; production uses useProviderConnection on the Models page. */
export function OpenRouterConnectionCardWithClient(
  props: ProviderConnectionProps & { client: OpenGeniBrowserClient },
) {
  return <StandaloneProviderConnection {...props} config={OPENROUTER_CONFIG} />;
}

function StandaloneProviderConnection(
  props: ProviderConnectionProps & {
    client: OpenGeniBrowserClient;
    config: ProviderConnectionConfig;
  },
) {
  const state = useProviderConnection(props);
  const [connecting, setConnecting] = useState(false);
  if (state.hidden) return null;
  if (connecting) {
    return (
      <ProviderConnectPage
        state={state}
        onClose={() => setConnecting(false)}
        onConnected={() => setConnecting(false)}
      />
    );
  }
  return <ProviderConnectionPage state={state} onConnect={() => setConnecting(true)} />;
}
