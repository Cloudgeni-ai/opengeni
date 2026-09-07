import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ArrowUpRightIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CreditAmountPicker } from "@/components/credit-amount-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validTopupAmount } from "@/lib/format";
import { applyConnectedModelToNewSessionDraft } from "@/lib/model-access-onboarding";
import { pollSuperGrokDeviceLogin } from "@/components/supergrok-device-poll";

type ProviderKey = "gateway" | "openrouter";

const PROVIDER_KEYS: Record<
  ProviderKey,
  {
    domain: string;
    role: string;
    label: string;
    placeholder: string;
  }
> = {
  gateway: {
    domain: "ai-gateway.vercel.sh",
    role: "vercel_ai_gateway",
    label: "Vercel AI Gateway",
    placeholder: "Vercel AI Gateway key",
  },
  openrouter: {
    domain: "openrouter.ai",
    role: "openrouter",
    label: "OpenRouter",
    placeholder: "OpenRouter API key",
  },
};

type DevicePending = {
  kind: "codex" | "supergrok";
  userCode: string;
  verificationUri: string;
};

/**
 * First-sign-in product step after the durable organization-name lifecycle.
 * Connecting a model updates the actor-private new-chat draft so the
 * next chat preselects it. Skip remains available; this does not change the 0348 API.
 */
export function ModelAccessOnboardingPanel({
  client,
  organizationId,
  workspaceId,
  billingMode = "disabled",
  codexEnabled = false,
  supergrokEnabled = false,
  onComplete,
}: {
  client?: OpenGeniBrowserClient;
  organizationId: string;
  workspaceId: string;
  billingMode?: "disabled" | "stripe";
  codexEnabled?: boolean;
  supergrokEnabled?: boolean;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DevicePending | null>(null);
  const [keyProvider, setKeyProvider] = useState<ProviderKey | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [selectionRetryAvailable, setSelectionRetryAvailable] = useState(false);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const codexPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerKeyOperation = useRef<{
    provider: ProviderKey;
    credential: string;
    operationId: string;
  } | null>(null);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      pollAbort.current?.abort();
      if (codexPollTimer.current) clearTimeout(codexPollTimer.current);
    };
  }, []);

  async function finishWithConnectedModel(): Promise<boolean> {
    if (client) {
      try {
        const modelId = await applyConnectedModelToNewSessionDraft(client, workspaceId);
        if (modelId) {
          setSelectionRetryAvailable(false);
          toast.success("Connected model selected for your next chat", {
            description: modelId,
          });
        } else {
          setSelectionRetryAvailable(true);
          toast.error("The connection is ready, but its model is not selectable yet");
          return false;
        }
      } catch (error) {
        setSelectionRetryAvailable(true);
        toast.error("Model connected, but your new-chat selection could not be saved", {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    onComplete();
    return true;
  }

  async function retryConnectedModelSelection(): Promise<void> {
    if (!client || busy) return;
    setBusy(true);
    try {
      await finishWithConnectedModel();
    } finally {
      setBusy(false);
    }
  }

  async function connectCodex(): Promise<void> {
    if (!client || busy) return;
    setBusy(true);
    try {
      const start = await client.codexConnectStart(workspaceId);
      setPending({
        kind: "codex",
        userCode: start.userCode,
        verificationUri: start.verificationUri,
      });
      window.open(start.verificationUri, "_blank", "noopener,noreferrer");
      const interval = Math.max(2, start.intervalSeconds) * 1000;
      const expiresAt = Date.now() + 15 * 60 * 1_000;
      const poll = async (): Promise<void> => {
        if (cancelled.current || Date.now() >= expiresAt) {
          if (!cancelled.current) {
            setPending(null);
            toast.error("The code expired before it was authorized. Try again.");
          }
          return;
        }
        let result: Awaited<ReturnType<OpenGeniBrowserClient["codexConnectPoll"]>>;
        try {
          result = await client.codexConnectPoll(workspaceId, start.state);
        } catch (error) {
          if (!cancelled.current) {
            setPending(null);
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to verify Codex authorization. Try again.",
            );
          }
          return;
        }
        if (result.status === "connected") {
          if (!cancelled.current) {
            setPending(null);
            toast.success(`Codex connected${result.plan ? ` (${result.plan} plan)` : ""}`);
            await finishWithConnectedModel();
          }
          return;
        }
        if (result.status === "expired") {
          if (!cancelled.current) {
            setPending(null);
            toast.error("The code expired before it was authorized. Try again.");
          }
          return;
        }
        codexPollTimer.current = setTimeout(() => void poll(), interval);
      };
      codexPollTimer.current = setTimeout(() => void poll(), interval);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start Codex login");
    } finally {
      setBusy(false);
    }
  }

  async function connectSuperGrok(): Promise<void> {
    if (!client || busy) return;
    setBusy(true);
    try {
      const start = await client.supergrokConnectStart(workspaceId, "user");
      setPending({
        kind: "supergrok",
        userCode: start.userCode,
        verificationUri: start.verificationUriComplete ?? start.verificationUri,
      });
      window.open(
        start.verificationUriComplete ?? start.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
      pollAbort.current?.abort();
      const controller = new AbortController();
      pollAbort.current = controller;
      const result = await pollSuperGrokDeviceLogin({
        poll: () => client.supergrokConnectPoll(workspaceId, start.state),
        initialIntervalSeconds: start.intervalSeconds,
        expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
        signal: controller.signal,
      });
      if (!result || controller.signal.aborted || cancelled.current) return;
      setPending(null);
      if (result.status === "connected") {
        toast.success("SuperGrok connected");
        await finishWithConnectedModel();
        return;
      }
      toast.error(result.status === "expired" ? "The xAI code expired" : "xAI login denied");
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Failed to start xAI login");
    } finally {
      setBusy(false);
    }
  }

  async function saveProviderKey(): Promise<void> {
    if (!client || !keyProvider || busy) return;
    const value = apiKey.trim();
    if (!value) {
      toast.error("Enter an API key");
      return;
    }
    const config = PROVIDER_KEYS[keyProvider];
    const priorOperation = providerKeyOperation.current;
    const operationId =
      priorOperation?.provider === keyProvider && priorOperation.credential === value
        ? priorOperation.operationId
        : crypto.randomUUID();
    providerKeyOperation.current = { provider: keyProvider, credential: value, operationId };
    setBusy(true);
    try {
      await client.createConnection(workspaceId, {
        providerDomain: config.domain,
        kind: "api_key",
        subjectId: null,
        credential: { apiKey: value },
        grantedScopes: [],
        metadata: {
          credentialRole: config.role,
          credentialLabel: config.label,
        },
        operationId,
      });
      toast.success(`${config.label} connected`);
      if (await finishWithConnectedModel()) providerKeyOperation.current = null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to connect ${config.label}`);
    } finally {
      setBusy(false);
    }
  }

  async function buyCredits(): Promise<void> {
    if (!client || busy) return;
    const amountUsd = Number(topupAmount);
    if (!validTopupAmount(topupAmount)) {
      toast.error("Enter $5 to $10,000 using no more than two decimal places");
      return;
    }
    setBusy(true);
    try {
      const session = await client.createBillingCheckout({
        amountUsd,
        accountId: organizationId,
        successUrl: `${window.location.origin}/workspaces/${workspaceId}`,
        cancelUrl: window.location.href,
      });
      window.location.assign(session.url);
    } catch (error) {
      toast.error("Checkout failed", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  function toggleKeyProvider(provider: ProviderKey): void {
    const next = keyProvider === provider ? null : provider;
    if (next !== keyProvider) {
      setApiKey("");
      providerKeyOperation.current = null;
    }
    setKeyProvider(next);
  }

  const validAmount = validTopupAmount(topupAmount);
  const providers = [
    {
      name: "Codex",
      description: "Use your ChatGPT subscription",
      action: () => void connectCodex(),
      disabled: !client,
    },
    {
      name: "SuperGrok",
      description: "Use your xAI subscription",
      action: () => void connectSuperGrok(),
      disabled: !client,
    },
    {
      name: "Vercel AI Gateway",
      description: "Use your own API key",
      action: () => toggleKeyProvider("gateway"),
      key: "gateway",
    },
    {
      name: "OpenRouter",
      description: "Use your own API key",
      action: () => toggleKeyProvider("openrouter"),
      key: "openrouter",
    },
  ].filter(
    (provider) =>
      (codexEnabled || provider.name !== "Codex") &&
      (supergrokEnabled || provider.name !== "SuperGrok"),
  );

  return (
    <section className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Choose how to power your chats</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Connect a service you already use, or get started with OpenGeni credits.
        </p>

        <div className="mt-7">
          {pending ? (
            <div className="grid gap-4 py-3" role="status">
              <div>
                <h3 className="text-sm font-medium">
                  Connect {pending.kind === "codex" ? "Codex" : "SuperGrok"}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">
                  Enter this code on the authorization page. This screen will update when you’re
                  connected.
                </p>
              </div>
              <p className="rounded-md bg-bg px-4 py-4 text-center font-mono text-2xl tracking-[0.18em] select-all">
                {pending.userCode}
              </p>
              <Button asChild type="button" variant="secondary">
                <a href={pending.verificationUri} target="_blank" rel="noreferrer">
                  Open authorization <ArrowUpRightIcon className="size-4" />
                </a>
              </Button>
              <p className="flex items-center justify-center gap-2 text-xs text-fg-subtle">
                <Loader2Icon className="size-3 animate-spin" /> Waiting for authorization
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {providers.map((provider) => (
                <div key={provider.name}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-16 w-full justify-between gap-4 rounded-md px-2 py-3 text-left"
                    aria-label={`Connect ${provider.name}`}
                    aria-expanded={provider.key ? keyProvider === provider.key : undefined}
                    disabled={busy || provider.disabled}
                    onClick={provider.action}
                  >
                    <span className="grid gap-1 whitespace-normal">
                      <span className="text-sm font-medium">{provider.name}</span>
                      <span className="text-xs font-normal text-fg-muted">
                        {provider.description}
                      </span>
                    </span>
                    <ChevronRightIcon
                      className={`size-4 text-fg-subtle transition-transform ${provider.key && keyProvider === provider.key ? "rotate-90" : ""}`}
                    />
                  </Button>
                  {provider.key && keyProvider === provider.key ? (
                    <div className="grid gap-2 px-2 pb-4 pt-1">
                      <Label htmlFor="onboarding-provider-key">
                        {PROVIDER_KEYS[keyProvider].label} API key
                      </Label>
                      <Input
                        id="onboarding-provider-key"
                        type="password"
                        autoComplete="off"
                        value={apiKey}
                        placeholder={PROVIDER_KEYS[keyProvider].placeholder}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                      <Button
                        type="button"
                        disabled={!client || busy || !apiKey.trim()}
                        onClick={() => void saveProviderKey()}
                      >
                        {busy ? <Loader2Icon className="size-4 animate-spin" /> : null} Connect{" "}
                        {provider.name}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {selectionRetryAvailable ? (
          <div className="mt-6 grid gap-3 rounded-lg border border-border bg-bg p-4" role="alert">
            <div>
              <p className="text-sm font-medium">Your service is connected</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                Its model is not selectable yet. Try again to use it for your next chat.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void retryConnectedModelSelection()}
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              Try again
            </Button>
          </div>
        ) : null}

        {billingMode === "stripe" ? (
          <div className="mt-6 grid gap-4 border-t border-border pt-6">
            <div>
              <h2 className="text-sm font-medium">Use OpenGeni credits</h2>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                Pay for hosted models as you go. No provider account needed.
              </p>
            </div>
            <CreditAmountPicker
              value={topupAmount}
              onChange={setTopupAmount}
              disabled={busy || !!pending}
            />
            <Button
              type="button"
              className="h-10 w-full"
              disabled={!client || busy || !!pending || !validAmount}
              onClick={() => void buyCredits()}
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {validAmount
                ? `Buy $${Number(topupAmount).toLocaleString("en-US", { maximumFractionDigits: 2 })} in credits`
                : "Buy credits"}
              <ArrowUpRightIcon className="size-4" />
            </Button>
            <p className="-mt-2 text-center text-xs text-fg-subtle">
              You’ll review your payment in Stripe Checkout.
            </p>
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="mt-5 w-full text-fg-muted"
          disabled={busy || !!pending}
          onClick={onComplete}
        >
          Skip for now
        </Button>
      </div>
    </section>
  );
}
