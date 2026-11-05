import {
  DirectModelProviderMetadata,
  directModelBaseUrl,
  directModelConnectionSpec,
  type DirectModelProvider,
} from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@opengeni/react/ui/button";
import { Input } from "@opengeni/react/ui/input";
import { Label } from "@opengeni/react/ui/label";

/** How each direct provider is named to the person connecting it. */
export const DIRECT_MODEL_PROVIDER_LABELS: Record<DirectModelProvider, string> = {
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  openai_compatible: "Custom endpoint",
};

/** A field of a direct model connection the person typed, keyed as in its metadata. */
export type DirectModelField = "endpoint" | "baseUrl" | "model" | "label";

/**
 * Checks a direct connection's settings before anything is sent. Returns the
 * settings, or what to fix in each field, in words that say how to fix it.
 */
export function parseDirectModelSettings(
  input: unknown,
  provider: DirectModelProvider,
):
  | { ok: true; config: DirectModelProviderMetadata }
  | { ok: false; errors: Partial<Record<DirectModelField, string>> } {
  const parsed = DirectModelProviderMetadata.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data };
  const compatible = provider === "openai_compatible";
  const errors: Partial<Record<DirectModelField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? (compatible ? "baseUrl" : "endpoint"));
    if (field === "endpoint")
      errors.endpoint = "Enter the HTTPS endpoint from your Azure OpenAI resource.";
    else if (field === "baseUrl")
      errors.baseUrl = "Enter your API’s public HTTPS base URL, like https://api.example.com/v1.";
    else if (field === "label") errors.label = "Use a name of up to 60 characters.";
    else
      errors.model = compatible
        ? "Enter the model ID exactly as your provider lists it."
        : "Enter a valid model or deployment name (letters, numbers, dots, underscores, or hyphens).";
  }
  return { ok: false, errors };
}

/**
 * Saves a workspace's own model key after one short test message to the
 * provider. Returns the connected model's ID; throws an Error whose message
 * is the server's explanation (an unreachable host, a wrong model ID).
 */
export async function connectDirectModelProvider(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  config: DirectModelProviderMetadata,
  apiKey: string,
  operationId: string,
): Promise<string> {
  const label = DIRECT_MODEL_PROVIDER_LABELS[config.provider];
  const providerDomain = new URL(directModelBaseUrl(config)).hostname;
  try {
    const connection = await client.createConnection(workspaceId, {
      providerDomain,
      kind: "api_key",
      subjectId: null,
      credential: { apiKey },
      grantedScopes: [],
      metadata: {
        credentialRole: `direct_${config.provider}`,
        credentialLabel:
          config.provider === "openai_compatible" ? (config.label ?? providerDomain) : label,
        directModelProvider: config,
      },
      operationId,
      verifyModelAccess: true,
    });
    const spec = directModelConnectionSpec(connection);
    if (!spec) throw new Error("The provider connection could not be loaded");
    return spec.modelId;
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
    throw new Error(message, { cause: error });
  }
}

/**
 * One idempotency key per distinct attempt: retrying the same key and
 * settings reuses it, so a lost response never creates a second connection.
 */
export function useConnectOperation() {
  const operation = useRef<{ signature: string; id: string } | null>(null);
  return {
    idFor(signature: string): string {
      if (operation.current?.signature !== signature)
        operation.current = { signature, id: crypto.randomUUID() };
      return operation.current.id;
    },
    reset() {
      operation.current = null;
    },
  };
}

/**
 * A workspace's own OpenAI or Azure OpenAI key, as the post-signup model step
 * connects it. A custom OpenAI-compatible endpoint has its own connect step
 * on the Models page (models/custom-endpoint-connect.tsx).
 */
export function DirectModelProviderForm({
  client,
  workspaceId,
  provider,
  onConnected,
  onBusyChange,
}: {
  client?: OpenGeniBrowserClient;
  workspaceId: string;
  provider: Exclude<DirectModelProvider, "openai_compatible">;
  onConnected?: (modelId: string) => Promise<void> | void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const label = DIRECT_MODEL_PROVIDER_LABELS[provider];
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState(provider === "openai" ? "gpt-6-sol" : "");
  const [busy, setBusy] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<DirectModelField, string>>>({});
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const operation = useConnectOperation();
  async function connect() {
    if (!client || busy) return;
    const settings = parseDirectModelSettings(
      { provider, model, ...(provider === "azure_openai" ? { endpoint } : {}) },
      provider,
    );
    setConnectionError(null);
    if (!settings.ok) {
      setErrors(settings.errors);
      if (settings.errors.model) setShowModel(true);
      return;
    }
    setErrors({});
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const modelId = await connectDirectModelProvider(
        client,
        workspaceId,
        settings.config,
        key,
        operation.idFor(JSON.stringify([key, settings.config])),
      );
      if (!mounted.current) return;
      setApiKey("");
      operation.reset();
      if (!onConnected) toast.success(`${label} connected`);
      await onConnected?.(modelId);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : `Could not connect ${label}`);
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
        {`Usage is billed directly to your ${label} account. This connection is available to this workspace.`}
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-key`}>{`${label} API key`}</Label>
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
        ) : (
          <p className="text-xs text-fg-muted">
            Find your key and endpoint in Azure portal → your OpenAI resource → Keys and Endpoint.
          </p>
        )}
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
            {provider === "azure_openai" ? "Deployment name" : "Model"}
          </Label>
          <Input
            id={`${id}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider === "openai" ? "gpt-6-sol" : "Your model deployment name"}
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
                : "Use a model your OpenAI account can access.")}
          </p>
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
          (provider === "azure_openai" && !endpoint.trim())
        }
        onClick={() => void connect()}
      >
        {busy ? "Checking connection…" : `Connect ${label}`}
      </Button>
    </div>
  );
}
