import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  CreditCardIcon,
  KeyRoundIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ChatGptMark } from "@/components/chatgpt-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyConnectedModelAsWorkspaceDefault } from "@/lib/model-access-onboarding";
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
 * Connecting a model writes the Personal workspace session default so new
 * chats preselect it. Skip remains available; this does not change the 0348 API.
 */
export function ModelAccessOnboardingPanel({
  client,
  organizationId,
  workspaceId,
  onComplete,
}: {
  client?: OpenGeniBrowserClient;
  organizationId: string;
  workspaceId: string;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DevicePending | null>(null);
  const [keyProvider, setKeyProvider] = useState<ProviderKey | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [billingMode, setBillingMode] = useState<"stripe" | "disabled" | "unknown">("unknown");
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      pollAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!client) {
      setBillingMode("disabled");
      return;
    }
    let active = true;
    void client
      .getBilling({ accountId: organizationId })
      .then((summary) => {
        if (!active) return;
        setBillingMode(summary.mode === "stripe" ? "stripe" : "disabled");
      })
      .catch(() => {
        if (!active) return;
        setBillingMode("disabled");
      });
    return () => {
      active = false;
    };
  }, [client, organizationId]);

  async function finishWithConnectedModel(): Promise<void> {
    if (client) {
      try {
        const modelId = await applyConnectedModelAsWorkspaceDefault(client, workspaceId);
        if (modelId) {
          toast.success("Connected model selected for new chats", {
            description: modelId,
          });
        }
      } catch (error) {
        toast.error("Model connected, but the new-chat default could not be saved", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }
    onComplete();
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
      const poll = async (): Promise<void> => {
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
        setTimeout(() => void poll(), interval);
      };
      setTimeout(() => void poll(), interval);
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
      const start = await client.supergrokConnectStart(workspaceId, "workspace");
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
        toast.success("SuperGrok connected for the workspace");
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
        operationId: crypto.randomUUID(),
      });
      toast.success(`${config.label} connected`);
      await finishWithConnectedModel();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to connect ${config.label}`);
    } finally {
      setBusy(false);
    }
  }

  async function buyCredits(): Promise<void> {
    if (!client || busy) return;
    const amountUsd = Number(topupAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < 5) {
      toast.error("Enter at least $5.00");
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

  return (
    <section className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <SparklesIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Connect a model or buy credits</h1>
            <p className="text-sm text-fg-subtle">
              New chats need a paid model path. Connect one you already pay for, or buy OpenGeni
              credits.
            </p>
          </div>
        </div>

        {pending ? (
          <div className="grid gap-3 rounded-md border border-border bg-surface-subtle p-3">
            <p className="text-sm text-fg">
              Authorize {pending.kind === "codex" ? "Codex" : "SuperGrok"} with this code, then
              return here.
            </p>
            <p className="font-mono text-lg tracking-wide">{pending.userCode}</p>
            <Button asChild type="button" size="sm" variant="secondary">
              <a href={pending.verificationUri} target="_blank" rel="noreferrer">
                Open authorization
              </a>
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <Button
              type="button"
              variant="secondary"
              className="justify-start"
              disabled={!client || busy}
              onClick={() => void connectCodex()}
            >
              <ChatGptMark className="size-3.5" />
              Connect Codex
              <span className="ml-auto text-xs font-normal text-fg-muted">ChatGPT plan</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="justify-start"
              disabled={!client || busy}
              onClick={() => void connectSuperGrok()}
            >
              Connect SuperGrok
              <span className="ml-auto text-xs font-normal text-fg-muted">xAI plan</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="justify-start"
              disabled={busy}
              onClick={() => setKeyProvider(keyProvider === "gateway" ? null : "gateway")}
            >
              <KeyRoundIcon className="size-3.5" />
              Connect Vercel AI Gateway
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="justify-start"
              disabled={busy}
              onClick={() => setKeyProvider(keyProvider === "openrouter" ? null : "openrouter")}
            >
              <KeyRoundIcon className="size-3.5" />
              Connect OpenRouter
            </Button>
            {keyProvider ? (
              <div className="grid gap-2 rounded-md border border-border p-3">
                <Label htmlFor="onboarding-provider-key">{PROVIDER_KEYS[keyProvider].label}</Label>
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
                  size="sm"
                  disabled={!client || busy || !apiKey.trim()}
                  onClick={() => void saveProviderKey()}
                >
                  {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                  Save key
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <div className="mt-4 grid gap-2 border-t border-border pt-4">
          <p className="text-xs text-fg-muted">Or buy OpenGeni credits for hosted models.</p>
          {billingMode === "stripe" ? (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                aria-label="Credit amount"
                type="number"
                min="5"
                max="10000"
                step="0.01"
                value={topupAmount}
                onChange={(event) => setTopupAmount(event.target.value)}
              />
              <Button
                type="button"
                disabled={!client || busy}
                onClick={() => void buyCredits()}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : <CreditCardIcon className="size-4" />}
                Buy credits
              </Button>
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">
              Credit checkout is available when Stripe billing is enabled for this deployment.
            </p>
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          className="mt-4 w-full"
          disabled={busy}
          onClick={onComplete}
        >
          Skip for now
        </Button>
      </div>
    </section>
  );
}
