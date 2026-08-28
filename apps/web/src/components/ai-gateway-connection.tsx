import type {
  ConnectionMetadata,
  WorkspaceGatewayCustomModel,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ChevronDownIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const GATEWAY_DOMAIN = "ai-gateway.vercel.sh";
const GATEWAY_ROLE = "vercel_ai_gateway";

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

function isGatewayConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.subjectId === null &&
    connection.providerDomain === GATEWAY_DOMAIN &&
    connection.kind === "api_key" &&
    connection.metadata.credentialRole === GATEWAY_ROLE
  );
}

type AiGatewayConnectionCardProps = {
  workspaceId: string;
  canManage: boolean;
  onConnectionChange?: (() => void) | undefined;
};

export function AiGatewayConnectionCard(props: AiGatewayConnectionCardProps) {
  const client = useAppContext().client;
  return <AiGatewayConnectionCardWithClient key={props.workspaceId} {...props} client={client} />;
}

/** Isolated product fixture seam; production callers use AiGatewayConnectionCard. */
export function AiGatewayConnectionCardWithClient(
  props: AiGatewayConnectionCardProps & { client: OpenGeniBrowserClient },
) {
  const client = props.client;
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [readOnlyConnected, setReadOnlyConnected] = useState(false);
  const [customModels, setCustomModels] = useState<WorkspaceGatewayCustomModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [customModelsLoaded, setCustomModelsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelSlug, setModelSlug] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [removingModelId, setRemovingModelId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const activeRef = useRef(true);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const connection = useMemo(() => {
    const gatewayConnections = connections.filter(isGatewayConnection);
    return (
      gatewayConnections.find((candidate) => candidate.status === "active") ??
      gatewayConnections[0] ??
      null
    );
  }, [connections]);
  const connected = props.canManage ? connection?.status === "active" : readOnlyConnected;
  const modelSlugValid = /^[!-{}-~]{1,256}$/.test(modelSlug);
  const modelSlugExists = customModels.some((model) => model.upstreamModelId === modelSlug);

  const refresh = useCallback(async () => {
    const [connectionResult, modelsResult] = await Promise.allSettled([
      props.canManage
        ? client.listConnections(props.workspaceId)
        : client.getWorkspaceModelCatalog(props.workspaceId),
      client.listWorkspaceGatewayCustomModels(props.workspaceId),
    ]);
    if (!activeRef.current) return;
    if (connectionResult.status === "fulfilled") {
      if (props.canManage) {
        setConnections(connectionResult.value as ConnectionMetadata[]);
      } else {
        setReadOnlyConnected(
          (connectionResult.value as { models: WorkspaceModelCatalogModel[] }).models.some(
            (model) =>
              model.source === "workspace_gateway" && model.credentialReadiness.status === "ready",
          ),
        );
      }
      setError(null);
    } else {
      setConnections([]);
      setReadOnlyConnected(false);
      setError(
        connectionResult.reason instanceof Error
          ? connectionResult.reason.message
          : String(connectionResult.reason),
      );
    }
    setLoaded(true);
    if (modelsResult.status === "fulfilled") {
      setCustomModels(modelsResult.value.models);
      setCustomModelsError(null);
    } else {
      setCustomModels([]);
      setCustomModelsError(
        modelsResult.reason instanceof Error
          ? modelsResult.reason.message
          : String(modelsResult.reason),
      );
    }
    setCustomModelsLoaded(true);
  }, [client, props.canManage, props.workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    const value = apiKey.trim();
    if (!value) return;
    setBusy(true);
    try {
      const metadata = {
        credentialRole: GATEWAY_ROLE,
        credentialLabel: "Vercel AI Gateway",
      };
      const saved =
        connection && connection.status !== "revoked"
          ? await client.updateConnection(props.workspaceId, connection.id, {
              status: "active",
              credential: { apiKey: value },
              metadata,
            })
          : await client.createConnection(props.workspaceId, {
              providerDomain: GATEWAY_DOMAIN,
              kind: "api_key",
              subjectId: null,
              credential: { apiKey: value },
              grantedScopes: [],
              metadata,
            });
      if (!activeRef.current) return;
      setConnections((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setApiKey("");
      setOpen(false);
      props.onConnectionChange?.();
      toast.success("Vercel AI Gateway connected");
    } catch (caught) {
      if (!activeRef.current) return;
      toast.error("Couldn't save Vercel AI Gateway key", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection) return;
    setBusy(true);
    try {
      const revoked = await client.deleteConnection(props.workspaceId, connection.id);
      if (!activeRef.current) return;
      setConnections((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      setOpen(false);
      props.onConnectionChange?.();
      toast.success("Vercel AI Gateway disconnected");
    } catch (caught) {
      if (!activeRef.current) return;
      toast.error("Couldn't disconnect Vercel AI Gateway", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  async function addCustomModel() {
    if (!modelSlugValid || modelSlugExists) return;
    setModelBusy(true);
    try {
      const created = await client.createWorkspaceGatewayCustomModel(props.workspaceId, {
        upstreamModelId: modelSlug,
      });
      if (!activeRef.current) return;
      setCustomModels((current) => [...current, created]);
      setModelSlug("");
      setCustomModelsError(null);
      props.onConnectionChange?.();
      toast.success("Gateway model added", {
        description: connected
          ? "It can now appear in this workspace's model picker."
          : "It will become selectable after the Gateway is connected.",
      });
    } catch (caught) {
      if (!activeRef.current) return;
      toast.error("Couldn't add Gateway model", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (activeRef.current) setModelBusy(false);
    }
  }

  async function removeCustomModel(model: WorkspaceGatewayCustomModel) {
    const modelIndex = customModels.findIndex((candidate) => candidate.id === model.id);
    const focusModelId =
      customModels[modelIndex + 1]?.id ?? customModels[modelIndex - 1]?.id ?? null;
    setRemovingModelId(model.id);
    try {
      await client.deleteWorkspaceGatewayCustomModel(props.workspaceId, model.id);
      if (!activeRef.current) return;
      setCustomModels((current) => current.filter((candidate) => candidate.id !== model.id));
      queueMicrotask(() => {
        if (!activeRef.current) return;
        if (focusModelId) removeButtonRefs.current.get(focusModelId)?.focus();
        else modelInputRef.current?.focus();
      });
      props.onConnectionChange?.();
      toast.success("Gateway model removed");
    } catch (caught) {
      if (!activeRef.current) return;
      toast.error("Couldn't remove Gateway model", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (activeRef.current) setRemovingModelId(null);
    }
  }

  // This is an admin-only opt-in. Non-admins only need to see it when the
  // workspace already connected one; the model picker exposes the usable rail.
  if (
    !props.canManage &&
    loaded &&
    customModelsLoaded &&
    !error &&
    !customModelsError &&
    !connected &&
    customModels.length === 0
  ) {
    return null;
  }

  return (
    <details
      className="group rounded-lg border border-border"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
        <VercelMark className="size-3.5 shrink-0 text-fg" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Bring your own Vercel AI Gateway
        </span>
        <span className="text-2xs text-fg-subtle">
          {!loaded ? "…" : connected ? "Connected" : error ? "Unavailable" : "Off"}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
      </summary>

      <div className="grid gap-3 border-t border-border/70 px-3 py-3">
        <p className="text-2xs text-fg-subtle">
          Use models through this workspace's Vercel account. Vercel bills usage directly instead of
          using OpenGeni credits.
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {props.canManage ? (
          <>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="h-9"
                placeholder={connected ? "Replace Vercel AI Gateway key" : "Vercel AI Gateway key"}
                aria-label="Vercel AI Gateway key"
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
          <p className="text-xs text-fg-subtle">
            Workspace admins manage this Vercel AI Gateway connection.
          </p>
        )}

        <div className="grid gap-2.5 border-t border-border/70 pt-3">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="grid gap-0.5">
              <p className="text-xs font-medium text-fg">Models from your Gateway</p>
              <p className="max-w-xl text-2xs leading-relaxed text-fg-subtle">
                Add an exact Vercel model slug. OpenGeni uses the Gateway's routing and does not
                inspect or pin a provider for custom entries.
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

          {props.canManage ? (
            <div className="grid gap-1.5">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  ref={modelInputRef}
                  value={modelSlug}
                  onChange={(event) => setModelSlug(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void addCustomModel();
                    }
                  }}
                  className="h-9 font-mono text-xs"
                  placeholder="anthropic/claude-sonnet-4.6"
                  aria-label="Vercel AI Gateway model slug"
                  aria-describedby="gateway-model-slug-help"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={modelBusy || !modelSlugValid || modelSlugExists}
                  onClick={addCustomModel}
                >
                  {modelBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  Add model
                </Button>
              </div>
              <p id="gateway-model-slug-help" className="text-2xs text-fg-subtle">
                {modelSlugExists
                  ? "That slug is already configured for this workspace."
                  : modelSlug && !modelSlugValid
                    ? "Use the exact printable slug with no spaces or |."
                    : connected
                      ? "The model becomes selectable when workspace policy allows it."
                      : "You can configure models now; they become selectable after you connect the Gateway."}
              </p>
            </div>
          ) : null}

          {customModelsError ? (
            <p className="text-xs text-destructive">{customModelsError}</p>
          ) : null}

          {customModelsLoaded && !customModelsError && customModels.length === 0 ? (
            <div className="rounded-md bg-surface-2/55 px-3 py-2.5 text-2xs text-fg-subtle">
              No custom model slugs yet. The curated Gateway models remain available separately.
            </div>
          ) : null}

          {customModels.length > 0 ? (
            <ul className="divide-y divide-border/70 rounded-md bg-surface-2/55 px-3">
              {customModels.map((model) => (
                <li key={model.id} className="flex min-w-0 items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-fg">{model.upstreamModelId}</p>
                    <p className="mt-0.5 text-2xs text-fg-subtle">
                      {connected
                        ? "Ready through Your Gateway"
                        : "Waiting for a Gateway connection"}
                    </p>
                  </div>
                  {props.canManage ? (
                    <Button
                      ref={(node) => {
                        if (node) removeButtonRefs.current.set(model.id, node);
                        else removeButtonRefs.current.delete(model.id);
                      }}
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0 text-fg-subtle hover:text-destructive"
                      disabled={removingModelId !== null}
                      aria-label={`Remove ${model.upstreamModelId}`}
                      onClick={() => void removeCustomModel(model)}
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
  );
}
