import {
  CompatibleModelBaseUrl,
  CompatibleModelName,
  type CompatibleModelApi,
} from "@opengeni/contracts";
import type {
  OrganizationCompatibleEndpoint as Endpoint,
  OrganizationProviderCustomModel as CustomModel,
} from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type {
  ProviderConnectionView,
  ProviderPresentation,
} from "@/components/ai-gateway-connection";
import { SecretInput } from "@/components/ui/secret-field";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
} from "@opengeni/react/app/lib/integration-connect-analytics";
import {
  invalidateSharedQueries,
  peekSharedQuery,
  sharedQueryWriter,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";
import { ModelsFormPage, ProviderTile } from "@opengeni/react/app/components/models/models-ui";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Field, FieldStack, TextInput, useField } from "@opengeni/react/ui/field";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

/* ----------------------------------------------------------------------------
   The organization's own OpenAI-compatible endpoints: a base URL, a key and
   the model IDs it serves. Each is an organization model account like its
   OpenAI key, connected from Connect provider with the same "Available in"
   step, and an organization can connect several. Every endpoint returns the
   same view as the organization's other keys, so its row and page are the
   shared provider row and page.
   -------------------------------------------------------------------------- */

/** How the Connect provider list names an endpoint. */
export const COMPATIBLE_ENDPOINT_CHOICE = {
  title: "OpenAI-compatible endpoint",
  summary: "Pay per token through your own provider",
  note: "Any API in OpenAI’s format: a base URL, an API key and a model ID",
} as const;

/** An endpoint's name: the one it was given, or its address. */
export function compatibleEndpointTitle(endpoint: Pick<Endpoint, "label" | "baseUrl">): string {
  if (endpoint.label) return endpoint.label;
  try {
    return new URL(endpoint.baseUrl).host;
  } catch {
    return endpoint.baseUrl;
  }
}

function endpointsKey(organizationId: string) {
  return [
    "model-settings",
    "organization-provider",
    organizationId,
    "openai_compatible",
    "endpoints",
  ] as const;
}

/** The organization's connected endpoints. Read only for owners and admins. */
export function useOrganizationCompatibleEndpoints({
  client,
  organizationId,
  enabled,
}: {
  client: OpenGeniBrowserClient;
  organizationId: string;
  enabled: boolean;
}) {
  const query = useSharedQuery(
    client,
    endpointsKey(organizationId),
    async () => (await client.listOrganizationCompatibleEndpoints(organizationId)).endpoints,
    { enabled, staleTimeMs: 5 * 60_000 },
  );
  const endpoints = (query.data ?? []).filter((endpoint) => endpoint.status === "active");
  return {
    client,
    organizationId,
    enabled,
    endpoints,
    loading: enabled && query.loading,
    error: enabled ? query.error : null,
    refresh: query.refresh,
  };
}

export type OrganizationCompatibleEndpoints = ReturnType<typeof useOrganizationCompatibleEndpoints>;

/** Replace one endpoint in the cached list (or drop it once it's disconnected). */
function writeEndpoint(
  client: OpenGeniBrowserClient,
  organizationId: string,
  next: Endpoint,
): void {
  const key = endpointsKey(organizationId);
  const current = peekSharedQuery<Endpoint[]>(client, key)?.data ?? [];
  sharedQueryWriter(client)(key, [
    ...current.filter((endpoint) => endpoint.id !== next.id),
    ...(next.status === "active" ? [next] : []),
  ]);
  void invalidateSharedQueries(client, ["model-settings"]);
}

/** The endpoint's own sentence when the API refused it, or plain advice. */
function endpointErrorText(error: unknown): string {
  if (error instanceof OpenGeniApiError) {
    try {
      const body = JSON.parse(error.body) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string" && error.status < 500) return body.error.message;
    } catch {
      /* Keep the plain advice when the body has no structured message. */
    }
  }
  return userErrorText(error);
}

/** Retry a request whose answer was lost; its operation id makes that safe. */
async function once<T>(mutate: () => Promise<T>): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    if (error instanceof OpenGeniApiError && !error.outcomeUnknown) throw error;
    return await mutate();
  }
}

function presentation(endpoint: Pick<Endpoint, "label" | "baseUrl"> | undefined) {
  return {
    title: endpoint ? compatibleEndpointTitle(endpoint) : COMPATIBLE_ENDPOINT_CHOICE.title,
    provider: "openai_compatible",
    billedTo: "The endpoint’s provider",
    summary:
      "Use models from any API that follows OpenAI’s Chat Completions or Responses format, billed by that provider.",
    keyHelp: "The API key your provider gave you for this endpoint.",
    keyAriaLabel: "Endpoint API key",
    endpointLabel: "Base URL",
    customModelsHeading: "Models",
    customModelsDescription:
      "Exact model IDs this endpoint serves. Each one is checked with the endpoint’s key before it is saved.",
    customModelsAfterConnect: "Models can be added while the endpoint is connected.",
    customModelInputAriaLabel: "Model ID",
    customModelPlaceholder: "provider/model-name",
    emptyCustomModelsDescription: "No models yet. Add one to offer it in workspaces.",
    readyModelDescription: "Ready in the workspaces it’s available in",
    waitingModelDescription: "Waiting for the endpoint to be connected",
    unavailableModelDescription: "Connection status unavailable",
    modelToastName: "model",
    connectionManagerDescription: "",
  } satisfies ProviderPresentation;
}

/**
 * One endpoint as the organization's other keys present themselves: its
 * models, Replace key, Disconnect and Available in.
 */
export function useCompatibleEndpointConnection({
  endpoints,
  connectionId,
}: {
  endpoints: OrganizationCompatibleEndpoints;
  connectionId: string;
}): ProviderConnectionView {
  const { client, organizationId, enabled } = endpoints;
  const endpoint = endpoints.endpoints.find((candidate) => candidate.id === connectionId);
  const models = endpoint?.models ?? [];
  const config = presentation(endpoint);
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<CustomModel | null>(null);
  const pendingKey = useRef<{ key: string; version: number; operationId: string } | null>(null);
  const pendingModel = useRef<{ slug: string; operationId: string } | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const addWorkflowRef = useRef<HTMLDivElement | null>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const removeFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreRemovalFocusRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connected = endpoint?.status === "active";
  const slugValid = slug.trim() === slug && CompatibleModelName.safeParse(slug).success;
  const slugExists = models.some((model) => model.upstreamModelId === slug);
  const slugInvalid = slug.length > 0 && (!slugValid || slugExists);
  const slugHelp = slugExists
    ? "That model is already added."
    : slug && !slugValid
      ? "Use the model ID exactly as your provider lists it, with no spaces."
      : "Enter the exact model ID, as your provider lists it under /models.";

  async function saveKey(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!endpoint || !key || busy) return false;
    const pending = pendingKey.current;
    const operationId =
      pending?.key === key && pending.version === endpoint.version
        ? pending.operationId
        : crypto.randomUUID();
    pendingKey.current = { key, version: endpoint.version, operationId };
    setBusy(true);
    try {
      const saved = await once(() =>
        client.replaceOrganizationCompatibleEndpointKey(organizationId, endpoint.id, {
          operationId,
          expectedVersion: endpoint.version,
          apiKey: key,
        }),
      );
      writeEndpoint(client, organizationId, saved);
      pendingKey.current = null;
      toast.success(`${config.title} key replaced`);
      return true;
    } catch (error) {
      toast.error(`Couldn't replace the ${config.title} key`, {
        description: endpointErrorText(error),
      });
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function disconnect(): Promise<boolean> {
    if (!endpoint) return true;
    setBusy(true);
    const operationId = crypto.randomUUID();
    try {
      const revoked = await once(() =>
        client.revokeOrganizationCompatibleEndpoint(organizationId, endpoint.id, {
          operationId,
          expectedVersion: endpoint.version,
        }),
      );
      writeEndpoint(client, organizationId, revoked);
      toast.success(`${config.title} disconnected`);
      return true;
    } catch (error) {
      toast.error(`Couldn't disconnect ${config.title}`, { description: userErrorText(error) });
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function addCustomModel(upstreamModelId?: string): Promise<void> {
    const submitted = upstreamModelId ?? slug;
    if (
      !endpoint ||
      modelBusy ||
      !CompatibleModelName.safeParse(submitted).success ||
      models.some((model) => model.upstreamModelId === submitted)
    )
      return;
    const pending = pendingModel.current;
    const operationId = pending?.slug === submitted ? pending.operationId : crypto.randomUUID();
    pendingModel.current = { slug: submitted, operationId };
    setModelBusy(true);
    try {
      const saved = await once(() =>
        client.createOrganizationCompatibleEndpointModel(organizationId, endpoint.id, {
          operationId,
          upstreamModelId: submitted,
        }),
      );
      writeEndpoint(client, organizationId, {
        ...endpoint,
        models: [...endpoint.models.filter((model) => model.id !== saved.id), saved],
      });
      pendingModel.current = null;
      if (mounted.current) setSlug((current) => (current === submitted ? "" : current));
      toast.success(`${submitted} added`, {
        description: "It can now appear in model pickers where the endpoint is available.",
      });
    } catch (error) {
      toast.error(`Couldn't add ${submitted}`, { description: endpointErrorText(error) });
    } finally {
      if (mounted.current) {
        setModelBusy(false);
        modelInputRef.current?.focus();
      }
    }
  }

  async function removeCustomModel(model: { id: string; version: number }): Promise<boolean> {
    if (!endpoint) return false;
    setRemovingId(model.id);
    const operationId = crypto.randomUUID();
    try {
      await once(() =>
        client.deleteOrganizationCompatibleEndpointModel(organizationId, endpoint.id, model.id, {
          operationId,
          expectedVersion: model.version,
        }),
      );
      writeEndpoint(client, organizationId, {
        ...endpoint,
        models: endpoint.models.filter((candidate) => candidate.id !== model.id),
      });
      toast.success("Model removed");
      return true;
    } catch (error) {
      toast.error("Couldn't remove the model", { description: userErrorText(error) });
      return false;
    } finally {
      if (mounted.current) setRemovingId(null);
    }
  }

  return {
    config,
    scopeLabel: "Organization",
    organization: true,
    accessTarget: { client, organizationId, kind: "openai_compatible", connectionId },
    canManageConnection: enabled && connected,
    canManageCustomModels: enabled && connected,
    canManageAccess: enabled,
    connected,
    settled: !endpoints.loading,
    hidden: !enabled,
    error: endpoints.error,
    customModelsError: null,
    customModels: models,
    customModelsLoaded: !endpoints.loading,
    busy,
    modelSlug: slug,
    modelBusy,
    modelSlugValid: slugValid,
    modelSlugExists: slugExists,
    modelSlugInvalid: slugInvalid,
    modelSlugHelp: slugHelp,
    removingModelId: removingId,
    modelPendingRemoval: pendingRemoval,
    modelInputRef,
    addWorkflowRef,
    removeButtonRefs,
    removeFocusTargetRef,
    restoreRemovalFocusRef,
    setModelSlug: setSlug,
    setModelPendingRemoval: (model) => setPendingRemoval(model as CustomModel | null),
    refreshConnection: endpoints.refresh,
    refreshCustomModels: endpoints.refresh,
    endpoint: endpoint?.baseUrl,
    saveKey,
    disconnect,
    addCustomModel,
    removeCustomModel,
  };
}

/** Renders `children` with one endpoint's view, for rows and pages built per endpoint. */
export function CompatibleEndpointView({
  endpoints,
  connectionId,
  children,
}: {
  endpoints: OrganizationCompatibleEndpoints;
  connectionId: string;
  children: (state: ProviderConnectionView) => ReactNode;
}) {
  return children(useCompatibleEndpointConnection({ endpoints, connectionId }));
}

const API_FORMATS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
] as const satisfies readonly { value: CompatibleModelApi; label: string }[];

function ApiFormatControl({
  value,
  onChange,
  disabled,
}: {
  value: CompatibleModelApi;
  onChange: (value: CompatibleModelApi) => void;
  disabled: boolean;
}) {
  const field = useField();
  return (
    <SegmentedControl
      options={API_FORMATS}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      className="max-w-full self-start"
    />
  );
}

/**
 * Connect an OpenAI-compatible endpoint for the organization: which
 * workspaces can use it (`fields`), then its base URL, key and first model.
 * The API checks them with a short test request before anything is saved.
 */
export function CompatibleEndpointConnectPage({
  endpoints,
  fields,
  blockedReason,
  onClose,
  onConnected,
  afterSave,
}: {
  endpoints: OrganizationCompatibleEndpoints;
  /** Fields above the endpoint's, such as which workspaces can use it. */
  fields?: ReactNode;
  /** Why it can't be connected yet (a choice above is incomplete). */
  blockedReason?: string | null;
  onClose: () => void;
  onConnected: (connectionId: string) => void;
  /** Runs once the endpoint is saved, before its page opens (the form stays pending). */
  afterSave?: ((connectionId: string) => Promise<void>) | undefined;
}) {
  const { client, organizationId } = endpoints;
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [api, setApi] = useState<CompatibleModelApi>("chat");
  const [label, setLabel] = useState("");
  const [checked, setChecked] = useState({ baseUrl: false, model: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const operation = useRef<{ signature: string; id: string } | null>(null);
  const connectedId = useRef<string | null>(null);
  const parsedBaseUrl = CompatibleModelBaseUrl.safeParse(baseUrl);
  const modelValid = CompatibleModelName.safeParse(model).success;
  const ready =
    parsedBaseUrl.success && modelValid && Boolean(apiKey.trim()) && label.trim().length <= 60;
  return (
    <ModelsFormPage
      connectStep
      headerAside={<ProviderTile provider="openai_compatible" />}
      title="Connect an OpenAI-compatible endpoint"
      description="Use models from any API that follows OpenAI’s Chat Completions or Responses format, such as a model host or your own server. Usage is billed by that provider."
      onClose={onClose}
      submitLabel="Connect endpoint"
      pendingLabel="Checking connection…"
      submitDisabled={!ready || Boolean(blockedReason)}
      disabledReason={blockedReason ?? undefined}
      footerStart="We’ll check it with a short test message before saving."
      error={error}
      onPendingChange={setPending}
      onSubmit={async () => {
        if (!parsedBaseUrl.success) return false;
        setError(null);
        const request = {
          baseUrl: parsedBaseUrl.data,
          apiKey: apiKey.trim(),
          model: model.trim(),
          api,
          ...(label.trim() ? { label: label.trim() } : {}),
        };
        const signature = JSON.stringify(request);
        if (operation.current?.signature !== signature)
          operation.current = { signature, id: crypto.randomUUID() };
        const operationId = operation.current.id;
        const journey = beginIntegrationConnect("openai_compatible", "api_key");
        try {
          const created = await once(() =>
            client.createOrganizationCompatibleEndpoint(organizationId, {
              operationId,
              ...request,
            }),
          );
          journey.finish("connected");
          writeEndpoint(client, organizationId, created);
          operation.current = null;
          connectedId.current = created.id;
          await afterSave?.(created.id);
          toast.success(`${compatibleEndpointTitle(created)} connected`);
          return true;
        } catch (failure) {
          journey.finish(integrationConnectErrorOutcome(failure));
          setError(endpointErrorText(failure));
          return false;
        }
      }}
      onSubmitted={() => {
        if (connectedId.current) onConnected(connectedId.current);
      }}
    >
      <FieldStack>
        {fields}
        <Field
          label="Base URL"
          hint="The address your provider’s docs give for its OpenAI-compatible API, usually ending in /v1."
          error={
            checked.baseUrl && baseUrl.trim() && !parsedBaseUrl.success
              ? "Enter your API’s public HTTPS base URL, like https://api.example.com/v1."
              : undefined
          }
          required
        >
          <TextInput
            mono
            type="url"
            inputMode="url"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
            }}
            onBlur={() => setChecked((current) => ({ ...current, baseUrl: true }))}
          />
        </Field>
        <Field
          label="API key"
          hint="The key your provider gave you. It is stored encrypted and never shown again."
          required
        >
          <SecretInput
            value={apiKey}
            autoComplete="off"
            aria-label="Endpoint API key"
            disabled={pending}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field
          label="Model ID"
          hint="Copy it exactly as your provider lists it under /models. You can add more models after connecting."
          error={
            checked.model && model.trim() && !modelValid
              ? "Enter the model ID exactly as your provider lists it."
              : undefined
          }
          required
        >
          <TextInput
            mono
            value={model}
            placeholder="provider/model-name"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setModel(event.target.value);
              setError(null);
            }}
            onBlur={() => setChecked((current) => ({ ...current, model: true }))}
          />
        </Field>
        <Field
          label="API format"
          group
          hint="Most compatible APIs support Chat Completions. Choose Responses only if your provider recommends it."
        >
          <ApiFormatControl value={api} onChange={setApi} disabled={pending} />
        </Field>
        <Field
          label="Name"
          optional
          hint="How it’s shown in your accounts and model pickers. Defaults to its address."
          error={label.trim().length > 60 ? "Use a name of up to 60 characters." : undefined}
        >
          <TextInput
            value={label}
            placeholder="Your provider’s name"
            maxLength={60}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
      </FieldStack>
    </ModelsFormPage>
  );
}
