import {
  DirectModelProviderMetadata,
  directModelConnectionSpec,
  type DirectModelProvider,
} from "@opengeni/contracts";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DirectModelProviderForm({
  client,
  workspaceId,
  provider,
  onConnected,
  onBusyChange,
}: {
  client?: OpenGeniBrowserClient;
  workspaceId: string;
  provider: DirectModelProvider;
  onConnected?: (modelId: string) => Promise<void> | void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const label = provider === "openai" ? "OpenAI" : "Azure OpenAI";
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
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
    if (!client || busy) return;
    const config = DirectModelProviderMetadata.safeParse({
      provider,
      model,
      ...(provider === "azure_openai" ? { endpoint } : {}),
    });
    setConnectionError(null);
    if (!config.success) {
      const issues: Record<string, string> = {};
      for (const issue of config.error.issues) {
        const field = String(issue.path[0] ?? "endpoint");
        issues[field] =
          field === "endpoint"
            ? "Enter the HTTPS endpoint from your Azure OpenAI resource."
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
      const connection = await client.createConnection(workspaceId, {
        providerDomain:
          provider === "openai" ? "api.openai.com" : new URL(config.data.endpoint!).hostname,
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
      if (!mounted.current) return;
      const spec = directModelConnectionSpec(connection);
      if (!spec) throw new Error("The provider connection could not be loaded");
      setApiKey("");
      operation.current = null;
      if (!onConnected) toast.success(`${label} connected`);
      await onConnected?.(spec.modelId);
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
        Usage is billed directly to your {label} account. This connection is available to this
        workspace.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-key`}>{label} API key</Label>
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
            className="text-xs text-brand hover:underline"
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
      {provider === "azure_openai" || showModel ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-model`}>
            {provider === "openai" ? "Model" : "Deployment name"}
          </Label>
          <Input
            id={`${id}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider === "openai" ? "gpt-6-sol" : "Your model deployment name"}
            disabled={busy}
            aria-invalid={!!errors.model}
            aria-describedby={`${id}-model-help`}
          />
          <p id={`${id}-model-help`} className="text-xs text-fg-muted">
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
