import {
  DirectModelProviderMetadata,
  directModelBaseUrl,
  directModelConnectionSpec,
  type CompatibleModelApi,
  type DirectModelProvider,
} from "@opengeni/contracts";
import type { ChatClient } from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@opengeni/react/ui/button";
import { Input } from "@opengeni/react/ui/input";
import { Label } from "@opengeni/react/ui/label";
import { Select } from "@opengeni/react/ui/select";

/** How each direct provider is named to the person connecting it. */
export const DIRECT_MODEL_PROVIDER_LABELS: Record<DirectModelProvider, string> = {
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI-compatible endpoint",
};

/**
 * The product model id of a model served by an organization's own
 * OpenAI-compatible endpoint (the catalog names it this way).
 */
export function organizationCompatibleModelId(connectionId: string, model: string): string {
  return `organization-compatible-${connectionId}/${model}`;
}

/**
 * Connect OpenAI or Azure OpenAI for one workspace, or an OpenAI-compatible
 * endpoint for the organization (`organizationId`), whose workspaces can then
 * use it like its other model accounts.
 */
export function DirectModelProviderForm({
  client,
  workspaceId,
  organizationId,
  provider,
  onConnected,
  onBusyChange,
}: {
  client?: ChatClient<OpenGeniBrowserClient>;
  workspaceId: string;
  /** Required for an OpenAI-compatible endpoint, which the organization owns. */
  organizationId?: string;
  provider: DirectModelProvider;
  onConnected?: (modelId: string) => Promise<void> | void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const label = DIRECT_MODEL_PROVIDER_LABELS[provider];
  const compatible = provider === "openai_compatible";
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState<CompatibleModelApi>("chat");
  const [name, setName] = useState("");
  const [model, setModel] = useState(provider === "openai" ? "gpt-6-sol" : "");
  const [busy, setBusy] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const operation = useRef<{ signature: string; id: string } | null>(null);
  async function connect() {
    if (!client || busy || (compatible && !organizationId)) return;
    const config = DirectModelProviderMetadata.safeParse({
      provider,
      model,
      ...(provider === "azure_openai" ? { endpoint } : {}),
      ...(compatible ? { baseUrl, api, ...(name.trim() ? { label: name } : {}) } : {}),
    });
    setConnectionError(null);
    if (!config.success) {
      const issues: Record<string, string> = {};
      for (const issue of config.error.issues) {
        const field = String(issue.path[0] ?? (compatible ? "baseUrl" : "endpoint"));
        issues[field] =
          field === "endpoint"
            ? "Enter the HTTPS endpoint from your Azure OpenAI resource."
            : field === "baseUrl"
              ? "Enter your API’s public HTTPS base URL, like https://api.example.com/v1."
              : field === "label"
                ? "Use a name of up to 60 characters."
                : compatible
                  ? "Enter the model ID exactly as your provider lists it."
                  : "Enter a valid model or deployment name (letters, numbers, dots, underscores, or hyphens).";
      }
      setErrors(issues);
      if (issues.model) setShowModel(true);
      return;
    }
    setErrors({});
    const key = apiKey.trim();
    if (!key) return;
    const signature = JSON.stringify([key, config.data]);
    if (operation.current?.signature !== signature)
      operation.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    onBusyChange?.(true);
    try {
      let modelId: string;
      if (compatible) {
        const created = await client.createOrganizationCompatibleEndpoint(organizationId!, {
          operationId: operation.current!.id,
          baseUrl: directModelBaseUrl(config.data),
          apiKey: key,
          model: config.data.model,
          api,
          ...(config.data.label ? { label: config.data.label } : {}),
        });
        modelId = organizationCompatibleModelId(created.id, config.data.model);
      } else {
        const connection = await client.createConnection(workspaceId, {
          providerDomain: new URL(directModelBaseUrl(config.data)).hostname,
          kind: "api_key",
          subjectId: null,
          credential: { apiKey: key },
          grantedScopes: [],
          metadata: {
            credentialRole: `direct_${provider}`,
            credentialLabel: label,
            directModelProvider: config.data,
          },
          operationId: operation.current!.id,
          verifyModelAccess: true,
        });
        const spec = directModelConnectionSpec(connection);
        if (!spec) throw new Error("The provider connection could not be loaded");
        modelId = spec.modelId;
      }
      if (!mounted.current) return;
      setApiKey("");
      operation.current = null;
      if (!onConnected) toast.success(`${label} connected`);
      await onConnected?.(modelId);
    } catch (error) {
      let message = error instanceof Error ? error.message : `Could not connect ${label}`;
      if (error instanceof OpenGeniApiError) {
        try {
          const body = JSON.parse(error.body);
          if (typeof body.error?.message === "string") message = body.error.message;
        } catch {
          /* Retain the safe SDK message when no structured error is present. */
        }
      }
      setConnectionError(message);
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  return (
    <div className="grid gap-3">
      <p className="text-xs leading-5 text-fg-muted">
        {compatible
          ? "Connect any API that follows OpenAI’s Chat Completions or Responses format, such as a model host or your own server. Usage is billed by that provider, and everyone in your organization can use it."
          : `Usage is billed directly to your ${label} account. This connection is available to this workspace.`}
      </p>
      {compatible ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-base-url`}>Base URL</Label>
          <Input
            id={`${id}-base-url`}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setConnectionError(null);
            }}
            placeholder="https://api.example.com/v1"
            inputMode="url"
            autoComplete="off"
            disabled={busy}
            aria-invalid={!!errors.baseUrl}
            aria-describedby={`${id}-base-url-help`}
          />
          <p
            id={`${id}-base-url-help`}
            className={errors.baseUrl ? "text-xs text-danger" : "text-xs text-fg-muted"}
          >
            {errors.baseUrl ??
              "The address your provider’s docs give for its OpenAI-compatible API, usually ending in /v1."}
          </p>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-key`}>{compatible ? "API key" : `${label} API key`}</Label>
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          placeholder="Paste your API key"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setConnectionError(null);
          }}
          disabled={busy}
        />
        {provider === "openai" ? (
          <a
            className="text-xs og-link"
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            Get an OpenAI API key ↗
          </a>
        ) : provider === "azure_openai" ? (
          <p className="text-xs text-fg-muted">
            Find your key and endpoint in Azure portal → your OpenAI resource → Keys and Endpoint.
          </p>
        ) : null}
      </div>
      {provider === "azure_openai" ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-endpoint`}>Azure OpenAI endpoint</Label>
          <Input
            id={`${id}-endpoint`}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-resource.openai.azure.com"
            disabled={busy}
            aria-invalid={!!errors.endpoint}
            aria-describedby={`${id}-endpoint-help`}
          />
          <p id={`${id}-endpoint-help`} className="text-xs text-fg-muted">
            {errors.endpoint ?? "Copy the Endpoint shown next to your Azure API key."}
          </p>
        </div>
      ) : null}
      {provider === "openai" ? (
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span>Model: {model}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showModel}
            disabled={busy}
            onClick={() => setShowModel(!showModel)}
          >
            {showModel ? "Done" : "Change model"}
          </Button>
        </div>
      ) : null}
      {provider !== "openai" || showModel ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-model`}>
            {provider === "azure_openai" ? "Deployment name" : compatible ? "Model ID" : "Model"}
          </Label>
          <Input
            id={`${id}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={
              provider === "openai"
                ? "gpt-6-sol"
                : compatible
                  ? "The model’s ID, like provider/model-name"
                  : "Your model deployment name"
            }
            autoComplete="off"
            disabled={busy}
            aria-invalid={!!errors.model}
            aria-describedby={`${id}-model-help`}
          />
          <p
            id={`${id}-model-help`}
            className={errors.model ? "text-xs text-danger" : "text-xs text-fg-muted"}
          >
            {errors.model ??
              (provider === "azure_openai"
                ? "In Microsoft Foundry, open Deployments and copy the deployment’s name."
                : compatible
                  ? "Copy it exactly as your provider lists it under /models. You can add more models later in Models settings."
                  : "Use a model your OpenAI account can access.")}
          </p>
        </div>
      ) : null}
      {compatible ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-api`}>API format</Label>
          <Select
            id={`${id}-api`}
            value={api}
            onChange={(e) => setApi(e.target.value as CompatibleModelApi)}
            disabled={busy}
            aria-describedby={`${id}-api-help`}
          >
            <option value="chat">Chat Completions</option>
            <option value="responses">Responses</option>
          </Select>
          <p id={`${id}-api-help`} className="text-xs text-fg-muted">
            Most compatible APIs support Chat Completions. Choose Responses only if your provider
            recommends it.
          </p>
        </div>
      ) : null}
      {compatible ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>Name (optional)</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your provider’s name"
            maxLength={60}
            disabled={busy}
            aria-invalid={!!errors.label}
            aria-describedby={errors.label ? `${id}-name-help` : undefined}
          />
          {errors.label ? (
            <p id={`${id}-name-help`} className="text-xs text-danger">
              {errors.label}
            </p>
          ) : null}
        </div>
      ) : null}
      {connectionError ? (
        <p role="alert" className="text-sm text-danger">
          {connectionError}
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">
        We’ll check the connection with a short test message before saving.
      </p>
      <Button
        type="button"
        disabled={
          !client ||
          busy ||
          !apiKey.trim() ||
          !model.trim() ||
          (provider === "azure_openai" && !endpoint.trim()) ||
          (compatible && (!baseUrl.trim() || !organizationId))
        }
        onClick={() => void connect()}
      >
        {busy ? "Checking connection…" : compatible ? "Connect endpoint" : `Connect ${label}`}
      </Button>
    </div>
  );
}
