import type { ConnectionMetadata, WorkspaceGatewayCustomModel } from "@opengeni/sdk";
import { WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH } from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ChevronDownIcon, Loader2Icon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";

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
  mark: (className: string) => ReactNode;
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

type ModelProviderConnectionCardProps = {
  workspaceId: string;
  canManageConnection: boolean;
  canManageCustomModels: boolean;
  onConnectionChange?: (() => void) | undefined;
};

const GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
const GATEWAY_ROLE = "vercel_ai_gateway";
const OPENROUTER_DOMAIN = "openrouter.ai";
const OPENROUTER_ROLE = "openrouter";

/** Vercel mark (simple-icons path) — currentColor so it matches surrounding chrome. */
function VercelMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M24 22.525H0l12-21.05 12 21.05z" />
    </svg>
  );
}

const VERCEL_AI_GATEWAY_CONFIG: ProviderConnectionConfig = {
  id: "vercel-ai-gateway",
  providerDomain: GATEWAY_DOMAIN,
  credentialRole: GATEWAY_ROLE,
  credentialLabel: "Vercel AI Gateway",
  readinessProvider: "workspace-gateway",
  title: "Bring your own Vercel AI Gateway",
  mark: (className) => <VercelMark className={className} />,
  billingDescription:
    "Use models through this workspace's Vercel account. The workspace's Vercel account is billed directly instead of using OpenGeni credits.",
  connectionManagerDescription:
    "Members with connection-management access manage this Vercel AI Gateway connection.",
  keyAriaLabel: "Vercel AI Gateway key",
  keyPlaceholder: (connected) =>
    connected ? "Replace Vercel AI Gateway key" : "Vercel AI Gateway key",
  customModelsHeading: "Models from your Gateway",
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
  title: "Bring your own OpenRouter",
  mark: (className) => <RouteIcon className={className} aria-hidden />,
  billingDescription:
    "Use models through this workspace's OpenRouter account. The workspace's OpenRouter account is billed directly. This is separate from deployment-provided OpenRouter models, including free models and models funded by deployment credits.",
  connectionManagerDescription:
    "Members with connection-management access manage this workspace OpenRouter connection.",
  keyAriaLabel: "OpenRouter API key",
  keyPlaceholder: (connected) => (connected ? "Replace OpenRouter API key" : "OpenRouter API key"),
  customModelsHeading: "Models from workspace OpenRouter",
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

export function AiGatewayConnectionCard(props: ModelProviderConnectionCardProps) {
  const client = useAppContext().client;
  return <AiGatewayConnectionCardWithClient key={props.workspaceId} {...props} client={client} />;
}

/** Isolated product fixture seam; production callers use AiGatewayConnectionCard. */
export function AiGatewayConnectionCardWithClient(
  props: ModelProviderConnectionCardProps & { client: OpenGeniBrowserClient },
) {
  return <ModelProviderConnectionCardWithClient {...props} config={VERCEL_AI_GATEWAY_CONFIG} />;
}

export function OpenRouterConnectionCard(props: ModelProviderConnectionCardProps) {
  const client = useAppContext().client;
  return <OpenRouterConnectionCardWithClient key={props.workspaceId} {...props} client={client} />;
}

/** Isolated product fixture seam; production callers use OpenRouterConnectionCard. */
export function OpenRouterConnectionCardWithClient(
  props: ModelProviderConnectionCardProps & { client: OpenGeniBrowserClient },
) {
  return <ModelProviderConnectionCardWithClient {...props} config={OPENROUTER_CONFIG} />;
}

function ModelProviderConnectionCardWithClient(
  props: ModelProviderConnectionCardProps & {
    client: OpenGeniBrowserClient;
    config: ProviderConnectionConfig;
  },
) {
  const client = props.client;
  const config = props.config;
  const modelSlugHelpId = useId();
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [readOnlyConnected, setReadOnlyConnected] = useState(false);
  const [customModels, setCustomModels] = useState<WorkspaceProviderCustomModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [customModelsLoaded, setCustomModelsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelSlug, setModelSlug] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [removingModelId, setRemovingModelId] = useState<string | null>(null);
  const [modelPendingRemoval, setModelPendingRemoval] =
    useState<WorkspaceProviderCustomModel | null>(null);
  const [open, setOpen] = useState(false);
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

  async function save() {
    const value = apiKey.trim();
    if (!value) return;
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
      connectionRequestGenerationRef.current += 1;
      setConnections((current) => [
        saved,
        ...current.filter((item) => !isProviderConnection(item, config)),
      ]);
      setError(null);
      setLoaded(true);
      setApiKey("");
      setOpen(false);
      props.onConnectionChange?.();
      toast.success(`${config.credentialLabel} connected`);
    };
    try {
      const saved = await saveConnection();
      if (!activeRef.current) return;
      commitSavedConnection(saved);
    } catch (caught) {
      if (!activeRef.current) return;
      let finalError = caught;
      const outcomeUnknown =
        caught instanceof OpenGeniApiError ? caught.outcomeUnknown : caught instanceof Error;
      if (outcomeUnknown) {
        try {
          const replayed = await saveConnection();
          if (!activeRef.current) return;
          commitSavedConnection(replayed);
          return;
        } catch (retryError) {
          finalError = retryError;
        }
      }
      await refreshConnection();
      if (!activeRef.current) return;
      toast.error(`Couldn't save ${config.credentialLabel} key`, {
        description: finalError instanceof Error ? finalError.message : String(finalError),
      });
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection) return;
    connectionRequestGenerationRef.current += 1;
    setBusy(true);
    try {
      await client.deleteConnection(props.workspaceId, connection.id);
      if (!activeRef.current) return;
      const reconciled = await refreshConnection();
      if (!activeRef.current) return;
      const committed =
        reconciled !== null &&
        !reconciled.some(
          (candidate) => isProviderConnection(candidate, config) && candidate.status === "active",
        );
      if (!committed) {
        toast.error(`Couldn't confirm ${config.credentialLabel} disconnect`, {
          description:
            reconciled === null
              ? "Reload the connection state before trying again."
              : `A newer ${config.credentialLabel} connection is still active.`,
        });
        return;
      }
      setOpen(false);
      props.onConnectionChange?.();
      toast.success(`${config.credentialLabel} disconnected`);
    } catch (caught) {
      if (!activeRef.current) return;
      const reconciled = await refreshConnection();
      if (!activeRef.current) return;
      const committed =
        reconciled !== null &&
        !reconciled.some(
          (candidate) => isProviderConnection(candidate, config) && candidate.status === "active",
        );
      if (committed) {
        setOpen(false);
        props.onConnectionChange?.();
        toast.success(`${config.credentialLabel} disconnected`);
        return;
      }
      toast.error(`Couldn't disconnect ${config.credentialLabel}`, {
        description: caught instanceof Error ? caught.message : String(caught),
      });
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
          : `It will become selectable after ${config.credentialLabel} is connected.`,
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

  // Hide an empty card only when the caller can manage neither the credential
  // nor custom models. Read-only members still see an existing connection or
  // catalog, and either management authority can reach its own controls.
  if (
    !props.canManageConnection &&
    !props.canManageCustomModels &&
    (!loaded || !customModelsLoaded)
  ) {
    return null;
  }
  if (
    !props.canManageConnection &&
    !props.canManageCustomModels &&
    loaded &&
    customModelsLoaded &&
    !error &&
    !customModelsError &&
    !connected &&
    customModels.length === 0
  ) {
    return null;
  }

  const summaryStatus =
    !loaded || !customModelsLoaded
      ? "…"
      : error || customModelsError
        ? "Unavailable"
        : connected
          ? "Connected"
          : "Off";

  return (
    <>
      <details
        className="group rounded-lg border border-border"
        data-testid={`${config.id}-connection-card`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
          {config.mark("size-3.5 shrink-0 text-fg")}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{config.title}</span>
          <span className="text-2xs text-fg-subtle">{summaryStatus}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
        </summary>

        <div className="grid gap-3 border-t border-border/70 px-3 py-3">
          <p className="text-2xs text-fg-subtle">{config.billingDescription}</p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {props.canManageConnection ? (
            <>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="h-9"
                  placeholder={config.keyPlaceholder(connected)}
                  aria-label={config.keyAriaLabel}
                />
                <Button type="button" disabled={busy || !apiKey.trim()} onClick={save}>
                  {busy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : connected ? (
                    "Replace"
                  ) : (
                    "Connect"
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-2xs text-fg-subtle">
                  Stored encrypted. Connecting does not run a model or spend credits.
                </p>
                {connected ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    className="text-destructive hover:text-destructive"
                    onClick={disconnect}
                  >
                    <Trash2Icon className="size-3.5" />
                    Disconnect
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-fg-subtle">{config.connectionManagerDescription}</p>
          )}

          <div className="grid gap-2.5 border-t border-border/70 pt-3">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <div className="grid gap-0.5">
                <p className="text-xs font-medium text-fg">{config.customModelsHeading}</p>
                <p className="max-w-xl text-2xs leading-relaxed text-fg-subtle">
                  {config.customModelsDescription}
                </p>
              </div>
              <span className="text-2xs text-fg-subtle" aria-live="polite">
                {!customModelsLoaded
                  ? "Loading…"
                  : customModelsError
                    ? "Unavailable"
                    : `${customModels.length} ${customModels.length === 1 ? "model" : "models"}`}
              </span>
            </div>

            {props.canManageCustomModels ? (
              <div ref={addWorkflowRef} className="grid gap-1.5">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    ref={modelInputRef}
                    value={modelSlug}
                    onChange={(event) => setModelSlug(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !modelBusy) {
                        event.preventDefault();
                        void addCustomModel();
                      }
                    }}
                    disabled={modelBusy}
                    className="h-9 font-mono text-base md:text-base"
                    placeholder={config.customModelPlaceholder}
                    aria-label={config.customModelInputAriaLabel}
                    aria-describedby={modelSlugHelpId}
                    aria-invalid={modelSlugInvalid || undefined}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={modelBusy || !modelSlugValid || modelSlugExists}
                    onClick={() => void addCustomModel()}
                    className="min-h-11"
                  >
                    {modelBusy ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    Add model
                  </Button>
                </div>
                <p
                  id={modelSlugHelpId}
                  className="text-2xs text-fg-subtle"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {modelSlugHelp}
                </p>
              </div>
            ) : null}

            {customModelsError ? (
              <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
                <p className="min-w-0 flex-1 text-xs text-destructive">{customModelsError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={modelBusy}
                  onClick={() => void refreshCustomModels()}
                  className="min-h-11"
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {customModelsLoaded && !customModelsError && customModels.length === 0 ? (
              <div className="rounded-md bg-surface-2/55 px-3 py-2.5 text-2xs text-fg-subtle">
                {config.emptyCustomModelsDescription}
              </div>
            ) : null}

            {customModelsLoaded && !customModelsError && customModels.length > 0 ? (
              <ul className="divide-y divide-border/70 rounded-md bg-surface-2/55 px-3">
                {customModels.map((model) => (
                  <li key={model.id} className="flex min-w-0 items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-fg">{model.upstreamModelId}</p>
                      <p className="mt-0.5 text-2xs text-fg-subtle">
                        {error
                          ? config.unavailableModelDescription
                          : connected
                            ? config.readyModelDescription
                            : config.waitingModelDescription}
                      </p>
                    </div>
                    {props.canManageCustomModels ? (
                      <Button
                        ref={(node) => {
                          if (node) removeButtonRefs.current.set(model.id, node);
                          else removeButtonRefs.current.delete(model.id);
                        }}
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="size-11 shrink-0 text-fg-subtle hover:text-destructive"
                        disabled={removingModelId !== null}
                        aria-label={`Remove ${model.upstreamModelId}`}
                        onClick={() => {
                          removeFocusTargetRef.current =
                            removeButtonRefs.current.get(model.id) ?? modelInputRef.current;
                          restoreRemovalFocusRef.current = true;
                          setModelPendingRemoval(model);
                        }}
                      >
                        {removingModelId === model.id ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2Icon className="size-3.5" />
                        )}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </details>
      <ConfirmDialog
        open={modelPendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setModelPendingRemoval(null);
        }}
        title={
          modelPendingRemoval ? (
            <>
              Remove {config.modelToastName} “
              <span className="break-all">{modelPendingRemoval.upstreamModelId}</span>”?
            </>
          ) : (
            `Remove ${config.modelToastName}?`
          )
        }
        description="The model disappears from new selections. Already accepted turns and existing sessions can continue with their retained definition."
        confirmLabel="Remove model"
        restoreFocusRef={removeFocusTargetRef}
        restoreFocusFallbackRef={modelInputRef}
        onConfirm={async () =>
          modelPendingRemoval ? await removeCustomModel(modelPendingRemoval) : false
        }
      />
    </>
  );
}
