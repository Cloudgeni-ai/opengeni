import { pollDeviceAuthorization } from "@opengeni/connect";
import type { CodexConnectPoll } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ArrowRightIcon, ArrowUpRightIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CreditAmountPicker } from "@/components/credit-amount-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { validTopupAmount } from "@/lib/format";
import {
  applyConnectedModelToNewSessionDraft,
  creditCheckoutSuccessUrl,
  creditsModelForCheckout,
  type ConnectedModelFamily,
} from "@/lib/model-access-onboarding";
import { pollSuperGrokDeviceLogin } from "@/components/supergrok-device-poll";

type ProviderKey = "gateway" | "openrouter";

const PROVIDER_KEYS: Record<
  ProviderKey,
  {
    domain: string;
    role: string;
    label: string;
    placeholder: string;
    family: ConnectedModelFamily;
  }
> = {
  gateway: {
    domain: "ai-gateway.vercel.sh",
    role: "vercel_ai_gateway",
    label: "Vercel AI Gateway",
    placeholder: "Vercel AI Gateway key",
    family: "vercel_gateway",
  },
  openrouter: {
    domain: "openrouter.ai",
    role: "openrouter",
    label: "OpenRouter",
    placeholder: "OpenRouter API key",
    family: "openrouter",
  },
};

/** ChatGPT keeps device code login behind a per-account (or workspace-admin) setting. */
export const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";
/** Codex does not report its device-code lifetime; OpenAI documents 15 minutes. */
const CODEX_DEVICE_CODE_TTL_MS = 15 * 60 * 1_000;
/** Show troubleshooting once a device login has waited this long. */
export const DEVICE_LOGIN_HINT_DELAY_MS = 60 * 1_000;

type DevicePending = {
  kind: "codex" | "supergrok";
  userCode: string;
  verificationUri: string;
};

export type IncludedOnboardingModel = { id: string; label: string; free: boolean };

/**
 * First-sign-in product step after the durable organization-name lifecycle.
 * When the deployment includes a default model, starting to chat with it is the
 * primary path and every connection or purchase is an optional upgrade.
 * Connecting a model updates the actor-private new-chat draft so the next chat
 * preselects that model. Leaving remains available; this does not change the 0348 API.
 */
export function ModelAccessOnboardingPanel({
  client,
  organizationId,
  workspaceId,
  billingMode = "disabled",
  codexEnabled = false,
  supergrokEnabled = false,
  includedModel = null,
  onComplete,
}: {
  client?: OpenGeniBrowserClient;
  organizationId: string;
  workspaceId: string;
  billingMode?: "disabled" | "stripe";
  codexEnabled?: boolean;
  supergrokEnabled?: boolean;
  includedModel?: IncludedOnboardingModel | null;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DevicePending | null>(null);
  const [pendingSlow, setPendingSlow] = useState(false);
  const [keyProvider, setKeyProvider] = useState<ProviderKey | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [selectionRetry, setSelectionRetry] = useState<ConnectedModelFamily | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
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
    };
  }, []);

  useEffect(() => {
    setPendingSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setPendingSlow(true), DEVICE_LOGIN_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  function stopDeviceLogin(): void {
    pollAbort.current?.abort();
    pollAbort.current = null;
    setPending(null);
  }

  function leaveOnboarding(): void {
    stopDeviceLogin();
    onComplete();
  }

  async function finishWithConnectedModel(family: ConnectedModelFamily): Promise<boolean> {
    if (client) {
      try {
        const model = await applyConnectedModelToNewSessionDraft(client, workspaceId, family);
        if (model) {
          setSelectionRetry(null);
          toast.success(`${model.label} is selected for your next chat`);
        } else {
          setSelectionRetry(family);
          toast.error("The connection is ready, but its model is not selectable yet");
          return false;
        }
      } catch (error) {
        setSelectionRetry(family);
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
    if (!client || busy || !selectionRetry) return;
    setBusy(true);
    try {
      await finishWithConnectedModel(selectionRetry);
    } finally {
      setBusy(false);
    }
  }

  async function startDeviceLogin(kind: DevicePending["kind"]): Promise<void> {
    if (!client || busy || pending) return;
    const label = kind === "codex" ? "Codex" : "xAI";
    setBusy(true);
    let begin: () => Promise<{ status: string; plan?: string | null } | null>;
    let verificationUri: string;
    const controller = new AbortController();
    try {
      if (kind === "codex") {
        const start = await client.codexConnectStart(workspaceId);
        verificationUri = start.verificationUri;
        setPending({ kind, userCode: start.userCode, verificationUri });
        begin = () =>
          pollDeviceAuthorization<CodexConnectPoll>({
            poll: () => client.codexConnectPoll(workspaceId, start.state),
            expired: { status: "expired" },
            initialIntervalSeconds: Math.max(2, start.intervalSeconds),
            expiresAtMs: Date.now() + CODEX_DEVICE_CODE_TTL_MS,
            signal: controller.signal,
          });
      } else {
        const start = await client.supergrokConnectStart(workspaceId, "user");
        verificationUri = start.verificationUriComplete ?? start.verificationUri;
        setPending({ kind, userCode: start.userCode, verificationUri });
        begin = () =>
          pollSuperGrokDeviceLogin({
            poll: () => client.supergrokConnectPoll(workspaceId, start.state),
            initialIntervalSeconds: start.intervalSeconds,
            expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
            signal: controller.signal,
          });
      }
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : `Failed to start ${label} login`);
      return;
    } finally {
      setBusy(false);
    }
    if (cancelled.current) return;
    pollAbort.current?.abort();
    pollAbort.current = controller;
    window.open(verificationUri, "_blank", "noopener,noreferrer");
    try {
      const result = await begin();
      if (!result || controller.signal.aborted || cancelled.current) return;
      pollAbort.current = null;
      setPending(null);
      if (result.status === "connected") {
        toast.success(
          kind === "codex"
            ? `Codex connected${result.plan ? ` (${result.plan} plan)` : ""}`
            : "SuperGrok connected",
        );
        await finishWithConnectedModel(kind);
        return;
      }
      toast.error(
        result.status === "denied"
          ? `${label} login was denied`
          : "The code expired before it was authorized. Try again.",
      );
    } catch (error) {
      if (controller.signal.aborted || cancelled.current) return;
      pollAbort.current = null;
      setPending(null);
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to verify ${label} authorization. Try again.`,
      );
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
      if (await finishWithConnectedModel(config.family)) providerKeyOperation.current = null;
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
      const creditsModel = await creditsModelForCheckout(client, workspaceId);
      const session = await client.createBillingCheckout({
        amountUsd,
        accountId: organizationId,
        successUrl: creditCheckoutSuccessUrl(window.location.origin, workspaceId, creditsModel),
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
      description: "Use your ChatGPT plan",
      action: () => void startDeviceLogin("codex"),
      disabled: !client,
    },
    {
      name: "SuperGrok",
      description: "Use your xAI subscription",
      action: () => void startDeviceLogin("supergrok"),
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

  const connectOptions = pending ? (
    <div className="grid gap-4 py-3" role="status">
      <div>
        <h3 className="text-sm font-medium">
          Connect {pending.kind === "codex" ? "Codex" : "SuperGrok"}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-fg-muted">
          Enter this code on the {pending.kind === "codex" ? "OpenAI" : "xAI"} page we opened in a
          new tab. This screen updates when you’re connected.
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
      {pending.kind === "codex" ? (
        <p className="text-xs leading-relaxed text-fg-muted">
          Device code login must be turned on in ChatGPT under Settings → Security. On Business or
          Enterprise plans, a workspace admin has to allow it.{" "}
          <a
            className="font-medium text-fg underline underline-offset-2"
            href={CHATGPT_SECURITY_SETTINGS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Open ChatGPT security settings
          </a>
        </p>
      ) : null}
      <p className="flex items-center justify-center gap-2 text-xs text-fg-subtle">
        <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" /> Waiting for
        authorization
      </p>
      {pendingSlow ? (
        <Notice tone="waiting" title="Still waiting?">
          {pending.kind === "codex"
            ? "Check that you entered the code exactly as shown and approved access. If ChatGPT says device code login is disabled, turn it on under Settings → Security (or ask your workspace admin), then cancel and try again."
            : "Check that you entered the code exactly as shown and approved access on the xAI page. If the code expired, cancel and try again."}
        </Notice>
      ) : null}
      <Button type="button" variant="ghost" onClick={stopDeviceLogin}>
        Cancel
      </Button>
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
              <span className="text-xs font-normal text-fg-muted">{provider.description}</span>
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
  );

  const selectionRetryNotice = selectionRetry ? (
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
  ) : null;

  const CreditsHeading = includedModel ? "h3" : "h2";
  const credits =
    billingMode === "stripe" ? (
      <div className="mt-6 grid gap-4 border-t border-border pt-6">
        <div>
          <CreditsHeading className="text-sm font-medium">Use OpenGeni credits</CreditsHeading>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {includedModel
              ? "Pay as you go for more capable hosted models."
              : "Pay for hosted models as you go."}{" "}
            No provider account needed.
          </p>
        </div>
        <CreditAmountPicker
          value={topupAmount}
          onChange={setTopupAmount}
          disabled={busy || !!pending}
        />
        <Button
          type="button"
          variant={includedModel ? "secondary" : "default"}
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
    ) : null;

  if (includedModel) {
    return (
      <section className="flex min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">
            {includedModel.free ? "Start chatting for free" : "You’re ready to chat"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {includedModel.free
              ? `${includedModel.label} is set up and free to use. No card or API key needed.`
              : `${includedModel.label} is set up and included with this deployment.`}
          </p>
          <Button
            type="button"
            className="mt-6 h-10 w-full"
            disabled={busy}
            onClick={leaveOnboarding}
          >
            {includedModel.free ? "Start chatting for free" : "Start chatting"}
            <ArrowRightIcon className="size-4" />
          </Button>

          <div className="mt-8 border-t border-border pt-6">
            <h2 className="text-sm font-medium">Want a more capable model? (optional)</h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              Connect a subscription or API key you already have
              {billingMode === "stripe" ? ", or add OpenGeni credits" : ""}. You can also do this
              later.
            </p>
            <div className="mt-3">{connectOptions}</div>
            {selectionRetryNotice}
            {credits}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Choose how to power your chats</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Connect a service you already use
          {billingMode === "stripe" ? ", or get started with OpenGeni credits" : ""}.
        </p>

        <div className="mt-7">{connectOptions}</div>
        {selectionRetryNotice}
        {credits}
        <Button
          type="button"
          variant="ghost"
          className="mt-5 w-full text-fg-muted"
          disabled={busy}
          onClick={leaveOnboarding}
        >
          Skip for now
        </Button>
      </div>
    </section>
  );
}
