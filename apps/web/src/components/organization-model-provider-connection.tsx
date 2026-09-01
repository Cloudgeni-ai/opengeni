import { WORKSPACE_GATEWAY_CUSTOM_MODEL_UPSTREAM_ID_MAX_LENGTH } from "@opengeni/contracts";
import type {
  OrganizationModelProviderConnection as Connection,
  OrganizationModelProviderKind as ProviderKind,
  OrganizationProviderCustomModel as CustomModel,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { ChevronDownIcon, Loader2Icon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";

const META: Record<
  ProviderKind,
  {
    title: string;
    shortName: string;
    placeholder: string;
    mark: ReactNode;
    distinction: string;
  }
> = {
  vercel_gateway: {
    title: "Vercel AI Gateway",
    shortName: "Gateway",
    placeholder: "anthropic/claude-sonnet-4.6",
    mark: (
      <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
        <path d="M24 22.525H0l12-21.05 12 21.05z" />
      </svg>
    ),
    distinction: "Separate from a Vercel AI Gateway connected to only one workspace.",
  },
  openrouter: {
    title: "OpenRouter",
    shortName: "OpenRouter",
    placeholder: "anthropic/claude-sonnet-4.6",
    mark: <RouteIcon className="size-3.5" aria-hidden="true" />,
    distinction:
      "Separate from deployment-provided OpenRouter models and accounts connected to only one workspace.",
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function OrganizationModelProviderConnection({
  organizationId,
  providerKind,
}: {
  organizationId: string;
  providerKind: ProviderKind;
}) {
  const client = useAppContext().client;
  const meta = META[providerKind];
  const helpId = useId();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [models, setModels] = useState<CustomModel[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [slug, setSlug] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<CustomModel | null>(null);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [open, setOpen] = useState(false);
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
  const disconnectButtonRef = useRef<HTMLButtonElement | null>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const removalFocusRef = useRef<HTMLElement | null>(null);

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
      setConnectionError(errorText(error));
      setLoaded(true);
      return undefined;
    }
  }, [client, organizationId, providerKind]);

  const refreshModels = useCallback(async (): Promise<CustomModel[] | undefined> => {
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
      setModelsError(errorText(error));
      setModelsLoaded(true);
      return undefined;
    }
  }, [client, organizationId, providerKind]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshConnection(), refreshModels()]);
  }, [refreshConnection, refreshModels]);

  useEffect(() => void refresh(), [refresh]);

  async function save(): Promise<void> {
    const key = apiKey.trim();
    if (!key || connectionBusy) return;
    const version = connection?.version ?? 0;
    const pending = pendingSaveRef.current;
    const operationId =
      pending?.key === key && pending.version === version
        ? pending.operationId
        : crypto.randomUUID();
    pendingSaveRef.current = { key, version, operationId };
    connectionGenerationRef.current += 1;
    setConnectionBusy(true);
    const mutate = () =>
      client.upsertOrganizationModelProviderConnection(organizationId, providerKind, {
        operationId,
        expectedVersion: version,
        apiKey: key,
      });
    const commit = (saved: Connection) => {
      pendingSaveRef.current = null;
      setConnection(saved);
      setConnectionError(null);
      setLoaded(true);
      setApiKey("");
      toast.success(`${meta.title} connected for shared workspaces`);
    };
    try {
      commit(await mutate());
    } catch (error) {
      let finalError = error;
      const outcomeUnknown =
        error instanceof OpenGeniApiError ? error.outcomeUnknown : error instanceof Error;
      if (outcomeUnknown) {
        try {
          commit(await mutate());
          return;
        } catch (retryError) {
          finalError = retryError;
        }
      }
      const reconciled = await refreshConnection();
      if (reconciled?.status === "active" && reconciled.version > version) {
        pendingSaveRef.current = null;
        setApiKey("");
        toast.success(`${meta.title} connected for shared workspaces`);
      } else {
        toast.error(`Couldn't connect ${meta.title}`, {
          description: errorText(finalError),
        });
      }
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
        description: errorText(error),
      });
      return false;
    } finally {
      if (activeRef.current) setConnectionBusy(false);
    }
  }

  async function addModel(): Promise<void> {
    if (!slugValid || slugExists || modelBusy) return;
    const submittedSlug = slug;
    const pending = pendingCreateRef.current;
    const operationId = pending?.slug === submittedSlug ? pending.operationId : crypto.randomUUID();
    pendingCreateRef.current = { slug: submittedSlug, operationId };
    modelsGenerationRef.current += 1;
    setModelBusy(true);
    const mutate = () =>
      client.createOrganizationProviderCustomModel(organizationId, providerKind, {
        operationId,
        upstreamModelId: submittedSlug,
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
          description: errorText(error),
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
        description: errorText(error),
      });
      return false;
    } finally {
      if (activeRef.current) setRemovingId(null);
    }
  }

  const summaryStatus =
    !loaded || !modelsLoaded
      ? "…"
      : connectionError || modelsError
        ? "Unavailable"
        : connected
          ? "Connected"
          : "Off";

  return (
    <>
      <details
        className="group rounded-lg border border-border"
        data-testid={`organization-${providerKind}-connection-card`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
          {meta.mark}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{meta.title}</span>
          <span className="text-2xs text-fg-subtle">{summaryStatus}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
        </summary>

        <div className="grid gap-3 border-t border-border/70 px-3 py-3">
          <p className="text-2xs leading-relaxed text-fg-subtle">
            The organization pays the provider directly; OpenGeni credits are not used. Every
            current and future shared workspace inherits these models. Personal workspaces do not.{" "}
            {meta.distinction}
          </p>
          {connectionError ? (
            <InlineError message={connectionError} retry={() => void refreshConnection()} />
          ) : null}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKey.trim() && !connectionBusy) void save();
              }}
              className="h-9"
              placeholder={
                connected ? `Replace organization ${meta.shortName} key` : `${meta.title} API key`
              }
              aria-label={`Organization ${meta.title} API key`}
            />
            <Button disabled={connectionBusy || !apiKey.trim()} onClick={() => void save()}>
              {connectionBusy ? (
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
              Stored encrypted. Connecting does not run a model or incur provider charges.
            </p>
            {connected ? (
              <Button
                ref={disconnectButtonRef}
                size="xs"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={connectionBusy}
                onClick={() => setDisconnectPending(true)}
              >
                <Trash2Icon className="size-3.5" /> Disconnect
              </Button>
            ) : null}
          </div>

          <div className="grid gap-2.5 border-t border-border/70 pt-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium">Organization models</p>
                <p className="mt-0.5 max-w-xl text-2xs leading-relaxed text-fg-subtle">
                  Add an exact provider model slug. Workspace policy can further restrict it.
                </p>
              </div>
              <span className="text-2xs text-fg-subtle" aria-live="polite">
                {!modelsLoaded
                  ? "Loading…"
                  : modelsError
                    ? "Unavailable"
                    : `${models.length} ${models.length === 1 ? "model" : "models"}`}
              </span>
            </div>
            <div className="grid gap-1.5">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  ref={modelInputRef}
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !modelBusy) {
                      event.preventDefault();
                      void addModel();
                    }
                  }}
                  disabled={modelBusy}
                  className="h-9 font-mono text-base md:text-base"
                  placeholder={meta.placeholder}
                  aria-label={`${meta.title} organization model slug`}
                  aria-describedby={helpId}
                  aria-invalid={slugInvalid || undefined}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={modelBusy || !slugValid || slugExists}
                  onClick={() => void addModel()}
                >
                  {modelBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  Add model
                </Button>
              </div>
              <p id={helpId} className="text-2xs text-fg-subtle" aria-live="polite">
                {slugHelp}
              </p>
            </div>
            {modelsError ? (
              <InlineError message={modelsError} retry={() => void refreshModels()} />
            ) : null}
            {modelsLoaded && !modelsError && models.length === 0 ? (
              <div className="rounded-md bg-surface-2/55 px-3 py-2.5 text-2xs text-fg-subtle">
                No organization model slugs yet. Add one to expose models from this account.
              </div>
            ) : null}
            {modelsLoaded && !modelsError && models.length > 0 ? (
              <ul className="divide-y divide-border/70 rounded-md bg-surface-2/55 px-3">
                {models.map((model) => (
                  <li key={model.id} className="flex min-w-0 items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      {model.label ? (
                        <p className="truncate text-xs text-fg">{model.label}</p>
                      ) : null}
                      <p className="truncate font-mono text-xs text-fg">{model.upstreamModelId}</p>
                      <p className="mt-0.5 text-2xs text-fg-subtle">
                        {connectionError
                          ? "Connection unavailable"
                          : connected
                            ? "Ready in shared workspaces"
                            : `Waiting for ${meta.shortName} connection`}
                      </p>
                    </div>
                    <Button
                      ref={(node) => {
                        if (node) removeButtonRefs.current.set(model.id, node);
                        else removeButtonRefs.current.delete(model.id);
                      }}
                      size="icon-xs"
                      variant="ghost"
                      className="size-11 shrink-0 text-fg-subtle hover:text-destructive"
                      disabled={removingId !== null}
                      aria-label={`Remove ${model.upstreamModelId}`}
                      onClick={() => {
                        removalFocusRef.current =
                          removeButtonRefs.current.get(model.id) ?? modelInputRef.current;
                        setPendingRemoval(model);
                      }}
                    >
                      {removingId === model.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </details>

      <ConfirmDialog
        open={disconnectPending}
        onOpenChange={setDisconnectPending}
        title={`Disconnect organization ${meta.title}?`}
        description="Its models stop being available for new selections in every shared workspace. Existing sessions keep their retained model definition."
        confirmLabel={`Disconnect ${meta.shortName}`}
        restoreFocusRef={disconnectButtonRef}
        onConfirm={disconnect}
      />
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
        title={pendingRemoval ? `Remove “${pendingRemoval.upstreamModelId}”?` : "Remove model?"}
        description="The model disappears from new selections in every shared workspace. Existing sessions keep their retained model definition."
        confirmLabel="Remove model"
        restoreFocusRef={removalFocusRef}
        restoreFocusFallbackRef={modelInputRef}
        onConfirm={async () => (pendingRemoval ? await removeModel(pendingRemoval) : false)}
      />
    </>
  );
}

function InlineError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2" role="alert">
      <p className="min-w-0 text-xs text-destructive">{message}</p>
      <Button size="sm" variant="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
