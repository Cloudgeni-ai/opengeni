import { modelDisplayName } from "@opengeni/sdk/model-display";
import { DirectModelProviderForm } from "@/components/direct-model-provider-connection";
import { pollDeviceAuthorization } from "@opengeni/connect";
import { labelReasoningEffort } from "@opengeni/react";
import type { BillingCheckoutStatus, CodexConnectPoll, CodexConnectStart } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CreditAmountPicker } from "@/components/credit-amount-picker";
import { CouponRedeem } from "@/components/credits/coupon-redeem";
import { OpenGeniCreditsTile, type ModelProviderId } from "@/components/models/provider-mark";
import {
  ProviderConnectList,
  providerPaymentSummary,
  type ProviderConnectChoice,
} from "@/components/models/provider-connect-list";
import { CelebrationBurst } from "@/components/onboarding/celebration-burst";
import { CreditsPrize } from "@/components/onboarding/credits-prize";
import { SubscriptionDeviceCodePanel } from "@/components/subscription-device-code-panel";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { ListRow } from "@/components/ui/list-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { validTopupAmount } from "@/lib/format";
import { userErrorText } from "@/lib/api-error";
import { analyticsAction } from "@/lib/analytics-actions";
import { beginModelConnectJourney } from "@/lib/integration-connect-analytics";
import { onboardingJourney } from "@/lib/onboarding-analytics";
import {
  applyConnectedModelToNewSessionDraft,
  creditCheckoutSuccessUrl,
  creditsModelForCheckout,
  type ConnectedModelFamily,
} from "@/lib/model-access-onboarding";
import type { StartingCreditsOnboarding } from "@/lib/onboarding-starting-credits";
import { formatCreditAmount } from "@/lib/onboarding-use-case";
import {
  isRetryableDevicePollError,
  pollSuperGrokDeviceLogin,
} from "@/components/supergrok-device-poll";

type ProviderKey = "vercel" | "openrouter";

const PROVIDER_KEYS: Record<
  ProviderKey,
  {
    domain: string;
    role: string;
    label: string;
    placeholder: string;
    help: string;
    family: ConnectedModelFamily;
    analytics: "connect_ai_gateway" | "connect_openrouter";
  }
> = {
  vercel: {
    domain: "ai-gateway.vercel.sh",
    role: "vercel_ai_gateway",
    label: "Vercel AI Gateway",
    placeholder: "Vercel AI Gateway key",
    help: "Create one in Vercel under AI Gateway, then API keys.",
    family: "vercel_gateway",
    analytics: "connect_ai_gateway",
  },
  openrouter: {
    domain: "openrouter.ai",
    role: "openrouter",
    label: "OpenRouter",
    placeholder: "OpenRouter API key",
    help: "Create one on openrouter.ai under Keys.",
    family: "openrouter",
    analytics: "connect_openrouter",
  },
};

/** Names the service in the selection toast; model labels repeat across services. */
const FAMILY_LABELS: Record<ConnectedModelFamily, string> = {
  codex: "Codex",
  supergrok: "SuperGrok",
  vercel_gateway: "Vercel AI Gateway",
  openrouter: "OpenRouter",
  credits: "Opengeni credits",
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
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

export type IncludedOnboardingModel = {
  id: string;
  label: string;
  free: boolean;
};

/** "GPT-6 Luna with extra high reasoning", or just the label when there is no effort to name. */
function describeCreditsModel(model: StartingCreditsOnboarding["model"]): string {
  const name = modelDisplayName(model);
  if (model.reasoningEffort === "none") return name;
  return `${name} with ${labelReasoningEffort(model.reasoningEffort).toLowerCase()} reasoning`;
}

/**
 * First-sign-in product step after the durable organization-name lifecycle.
 * When the organization already holds Opengeni credits (for example the
 * verified-signup trial grant) and new chats default to a credits model,
 * starting to chat on those credits is the primary path: the step shows the
 * balance and the resolved default, and names the free model as what applies
 * once the credits run out. Otherwise, when the deployment includes a default
 * model, starting to chat with it is the primary path. Every connection or
 * purchase is an optional upgrade. Connecting a model updates the
 * actor-private new-chat draft so the next chat preselects that model. Leaving
 * remains available; this does not change the 0348 API.
 *
 * The person here just created the organization, so a subscription (Codex,
 * SuperGrok) connects for everyone in it, and reaches their Personal
 * workspace through the organization. API keys stay in the Personal
 * workspace: the organization's keys serve shared workspaces only, so an
 * organization key would not pay for the next chat.
 */
export function ModelAccessOnboardingPanel({
  client,
  organizationId,
  organizationName,
  workspaceId,
  billingMode = "disabled",
  codexEnabled = false,
  supergrokEnabled = false,
  includedModel = null,
  startingCredits = null,
  continueToNextStep = false,
  onComplete,
}: {
  client?: OpenGeniBrowserClient;
  organizationId: string;
  /** The new organization's name, for "Shared with everyone in Acme". */
  organizationName?: string | undefined;
  workspaceId: string;
  billingMode?: "disabled" | "stripe";
  codexEnabled?: boolean;
  supergrokEnabled?: boolean;
  includedModel?: IncludedOnboardingModel | null;
  startingCredits?: StartingCreditsOnboarding | null;
  /**
   * Another onboarding step follows (the developer setup for "Add AI agents to
   * my product"), so the primary action reads Continue instead of naming chat.
   */
  continueToNextStep?: boolean;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DevicePending | null>(null);
  const [pendingSlow, setPendingSlow] = useState(false);
  // The row whose connect step is open: a provider, or buying credits.
  const [open, setOpen] = useState<ModelProviderId | "credits" | null>(
    !startingCredits && !includedModel && billingMode === "stripe" ? "credits" : null,
  );
  const keyProvider: ProviderKey | null = open === "vercel" || open === "openrouter" ? open : null;
  const connectedModelId = useRef<string | undefined>(undefined);
  const [apiKey, setApiKey] = useState("");
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [selectionRetry, setSelectionRetry] = useState<ConnectedModelFamily | null>(null);
  // Credits a coupon (or a purchase) just added, celebrated in place.
  const [won, setWon] = useState<{
    amountMicros: number;
    balanceMicros: number | null;
    free: boolean;
    celebration: number;
  } | null>(null);
  const cancelled = useRef(false);
  // Set while a connected model is being saved as the next-chat selection.
  const finishing = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const providerKeyOperation = useRef<{
    provider: ProviderKey;
    credential: string;
    operationId: string;
  } | null>(null);

  const variant = startingCredits ? "credits" : includedModel ? "included" : "choose";
  useEffect(() => {
    onboardingJourney().viewed("model_access", variant);
  }, [variant]);

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
    // Leaving mid-save would complete twice or drop the connected selection.
    if (finishing.current) return;
    stopDeviceLogin();
    onboardingJourney().completed(
      "model_access",
      variant === "choose" && !won ? "skipped" : "start_chatting",
    );
    onComplete();
  }

  async function finishWithConnectedModel(
    family: ConnectedModelFamily,
    preferredModelId?: string,
  ): Promise<boolean> {
    connectedModelId.current = preferredModelId;
    if (client) {
      finishing.current = true;
      try {
        const model = await applyConnectedModelToNewSessionDraft(
          client,
          workspaceId,
          family,
          preferredModelId,
        );
        if (model) {
          setSelectionRetry(null);
          toast.success(
            `${modelDisplayName(model)} (${FAMILY_LABELS[family]}) is selected for your next chat`,
          );
        } else {
          setSelectionRetry(family);
          toast.error("The connection is ready, but its model is not selectable yet");
          return false;
        }
      } catch (error) {
        setSelectionRetry(family);
        toast.error("Model connected, but your new-chat selection could not be saved", {
          description: userErrorText(error),
        });
        return false;
      } finally {
        finishing.current = false;
      }
    }
    onboardingJourney().completed("model_access", "connected_model");
    onComplete();
    return true;
  }

  async function retryConnectedModelSelection(): Promise<void> {
    if (!client || busy || !selectionRetry) return;
    setBusy(true);
    try {
      await finishWithConnectedModel(selectionRetry, connectedModelId.current);
    } finally {
      setBusy(false);
    }
  }

  async function startDeviceLogin(kind: DevicePending["kind"]): Promise<void> {
    if (!client || busy || pending) return;
    const label = kind === "codex" ? "Codex" : "xAI";
    const recordOutcome = beginModelConnectJourney(kind, "device_code");
    setBusy(true);
    let begin: () => Promise<{ status: string; plan?: string | null } | null>;
    let verificationUri: string;
    const controller = new AbortController();
    try {
      // Subscriptions connect for the whole organization (its creator is its
      // owner); the Personal workspace uses the organization's accounts.
      if (kind === "codex") {
        const start = await client.requestJson<CodexConnectStart>(
          "POST",
          `/v1/organizations/${organizationId}/codex/connect/start`,
          {},
        );
        verificationUri = start.verificationUri;
        setPending({ kind, userCode: start.userCode, verificationUri });
        begin = () =>
          pollDeviceAuthorization<CodexConnectPoll>({
            poll: () =>
              client.requestJson<CodexConnectPoll>(
                "POST",
                `/v1/organizations/${organizationId}/codex/connect/poll`,
                { state: start.state },
              ),
            expired: { status: "expired" },
            initialIntervalSeconds: Math.max(2, start.intervalSeconds),
            expiresAtMs: Date.now() + CODEX_DEVICE_CODE_TTL_MS,
            signal: controller.signal,
            retryable: isRetryableDevicePollError,
          });
      } else {
        const start = await client.organizationSupergrokConnectStart(organizationId);
        verificationUri = start.verificationUriComplete ?? start.verificationUri;
        setPending({ kind, userCode: start.userCode, verificationUri });
        begin = () =>
          pollSuperGrokDeviceLogin({
            poll: () => client.organizationSupergrokConnectPoll(organizationId, start.state),
            initialIntervalSeconds: start.intervalSeconds,
            expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
            signal: controller.signal,
          });
      }
    } catch (error) {
      recordOutcome("outcome_unknown");
      setPending(null);
      toast.error(`Couldn't start the ${label} sign-in`, {
        description: userErrorText(error),
      });
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
        recordOutcome("connected");
        toast.success(
          kind === "codex"
            ? `Codex connected for ${organizationName || "your organization"}${result.plan ? ` (${result.plan} plan)` : ""}`
            : `SuperGrok connected for ${organizationName || "your organization"}`,
        );
        // Hold the leave buttons until the connected model is the next-chat selection.
        setBusy(true);
        try {
          await finishWithConnectedModel(kind);
        } finally {
          if (!cancelled.current) setBusy(false);
        }
        return;
      }
      recordOutcome(result.status === "denied" ? "denied" : "expired");
      toast.error(
        result.status === "denied"
          ? `${label} login was denied`
          : "The code expired before it was authorized. Try again.",
      );
    } catch (error) {
      recordOutcome(controller.signal.aborted ? "expired" : "outcome_unknown");
      if (controller.signal.aborted || cancelled.current) return;
      pollAbort.current = null;
      setPending(null);
      toast.error(`Couldn't confirm the ${label} sign-in`, {
        description: userErrorText(error),
      });
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
    providerKeyOperation.current = {
      provider: keyProvider,
      credential: value,
      operationId,
    };
    const recordOutcome = beginModelConnectJourney(config.family, "api_key");
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
      recordOutcome("connected");
      toast.success(`${config.label} connected`);
      if (await finishWithConnectedModel(config.family)) providerKeyOperation.current = null;
    } catch (error) {
      recordOutcome("outcome_unknown");
      toast.error(`Couldn't connect ${config.label}`, {
        description: userErrorText(error),
      });
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
      onboardingJourney().completed("model_access", "checkout");
      window.location.assign(session.url);
    } catch (error) {
      toast.error("Checkout failed", { description: userErrorText(error) });
      setBusy(false);
    }
  }

  function toggleRow(row: ModelProviderId | "credits"): void {
    // Opening another provider leaves a device login or key half-entered behind.
    if (busy) return;
    stopDeviceLogin();
    setApiKey("");
    providerKeyOperation.current = null;
    setOpen((current) => (current === row ? null : row));
  }

  function celebrateCheckout(status: BillingCheckoutStatus): void {
    setWon((previous) => ({
      amountMicros: status.credit.amountMicros,
      balanceMicros: status.balance?.balanceMicros ?? null,
      free: status.credit.free,
      celebration: (previous?.celebration ?? 0) + 1,
    }));
    // Without a credits default yet, make the next chat use the credits just added.
    if (!startingCredits && client) {
      void applyConnectedModelToNewSessionDraft(client, workspaceId, "credits").catch(
        () => undefined,
      );
    }
  }

  const coupon =
    billingMode === "stripe" ? (
      <CouponRedeem
        client={client}
        accountId={organizationId}
        workspaceId={workspaceId}
        disabled={busy || !!pending}
        onGranted={celebrateCheckout}
      />
    ) : null;

  const validAmount = validTopupAmount(topupAmount);
  const everyone = `For everyone in ${organizationName || "your organization"}`;
  const providerChoices: ProviderConnectChoice[] = [
    ...(codexEnabled
      ? [
          {
            id: "codex" as const,
            title: "Codex",
            summary: providerPaymentSummary("codex", "Codex"),
            note: everyone,
          },
        ]
      : []),
    ...(supergrokEnabled
      ? [
          {
            id: "supergrok" as const,
            title: "SuperGrok",
            summary: providerPaymentSummary("supergrok", "SuperGrok"),
            note: everyone,
          },
        ]
      : []),
    ...(
      [
        ["openai", "OpenAI"],
        ["azure_openai", "Azure OpenAI"],
        ["openrouter", "OpenRouter"],
        ["vercel", "Vercel AI Gateway"],
      ] as const
    ).map(([id, title]) => ({
      id,
      title,
      summary: providerPaymentSummary(id, title),
    })),
  ];

  function devicePanel(kind: DevicePending["kind"]): ReactNode {
    const name = kind === "codex" ? "ChatGPT" : "xAI";
    if (!pending || pending.kind !== kind) {
      return (
        <div className="grid gap-3">
          <p className="m-0 text-xs leading-relaxed text-fg-muted">
            {kind === "codex"
              ? "Sign in with the ChatGPT account whose plan should pay for new chats."
              : "Sign in with the xAI account whose SuperGrok plan should pay for Grok models."}
          </p>
          <Button
            type="button"
            className="w-full sm:w-fit"
            disabled={!client || busy}
            onClick={() => void startDeviceLogin(kind)}
            {...analyticsAction(kind === "codex" ? "connect_codex" : "connect_supergrok")}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Sign in with {name}
          </Button>
        </div>
      );
    }
    return (
      <div className="grid gap-4">
        <SubscriptionDeviceCodePanel
          provider={pending.kind}
          userCode={pending.userCode}
          verificationUri={pending.verificationUri}
          onCopyResult={(copied) =>
            copied
              ? toast.success("Code copied")
              : toast.error("Couldn't copy the code", {
                  description: "Copy it manually instead.",
                })
          }
        />
        {pendingSlow ? (
          <Notice tone="waiting" title="Still waiting?">
            {pending.kind === "codex" ? (
              <>
                Check that you entered the code exactly as shown. If ChatGPT says device code login
                is off, turn it on in ChatGPT under Settings, Security (on Business and Enterprise
                plans a ChatGPT admin allows it), then cancel and try again.{" "}
                <a
                  className="font-medium text-fg underline underline-offset-2"
                  href={CHATGPT_SECURITY_SETTINGS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open ChatGPT security settings
                </a>
              </>
            ) : (
              "Check that you entered the code exactly as shown and approved access on the xAI page. If the code expired, cancel and try again."
            )}
          </Notice>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-fit"
          onClick={stopDeviceLogin}
        >
          Cancel
        </Button>
      </div>
    );
  }

  function keyPanel(provider: ProviderKey): ReactNode {
    const config = PROVIDER_KEYS[provider];
    return (
      <div className="grid gap-2">
        <Label htmlFor="onboarding-provider-key">{config.label} API key</Label>
        <Input
          id="onboarding-provider-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={config.placeholder}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="m-0 text-xs text-fg-muted">{config.help}</p>
        <Button
          type="button"
          className="mt-1 w-full sm:w-fit"
          disabled={!client || busy || !apiKey.trim()}
          onClick={() => void saveProviderKey()}
          {...analyticsAction(config.analytics)}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null} Connect {config.label}
        </Button>
      </div>
    );
  }

  function providerPanel(choice: ProviderConnectChoice): ReactNode {
    if (choice.id === "codex" || choice.id === "supergrok") return devicePanel(choice.id);
    if (choice.id === "openai" || choice.id === "azure_openai") {
      const provider = choice.id;
      return (
        <DirectModelProviderForm
          client={client}
          workspaceId={workspaceId}
          provider={provider}
          onBusyChange={setBusy}
          onConnected={async (modelId) => {
            await finishWithConnectedModel(provider, modelId);
          }}
        />
      );
    }
    return choice.id === "vercel" || choice.id === "openrouter" ? keyPanel(choice.id) : null;
  }

  const creditsPanel =
    billingMode === "stripe" ? (
      <div className="grid gap-3">
        <CreditAmountPicker
          value={topupAmount}
          onChange={setTopupAmount}
          disabled={busy || !!pending}
        />
        <Button
          type="button"
          className="w-full"
          disabled={!client || busy || !!pending || !validAmount}
          onClick={() => void buyCredits()}
          {...analyticsAction("buy_credits")}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {validAmount
            ? `Buy $${Number(topupAmount).toLocaleString("en-US", { maximumFractionDigits: 2 })} in credits`
            : "Buy credits"}
          <ArrowUpRightIcon className="size-4" />
        </Button>
        <p className="m-0 text-xs text-fg-subtle">You’ll review your payment in Stripe Checkout.</p>
      </div>
    ) : null;

  const creditsRow = creditsPanel ? (
    <ListRow
      leading={<OpenGeniCreditsTile size="lg" />}
      title={startingCredits || won ? "Buy more Opengeni credits" : "Opengeni credits"}
      meta={["Pay as you go", "No provider account needed"]}
      indicator="expand"
      expanded={open === "credits"}
      panel={open === "credits" ? creditsPanel : null}
      onOpen={() => toggleRow("credits")}
    />
  ) : null;

  const connectOptions = (
    <ProviderConnectList
      label="Ways to pay"
      choices={providerChoices}
      expanded={open === "credits" ? null : open}
      panel={providerPanel}
      onOpen={(choice) => toggleRow(choice.id)}
      leadingRows={creditsRow}
    />
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
        variant="outline"
        disabled={busy}
        onClick={() => void retryConnectedModelSelection()}
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Try again
      </Button>
    </div>
  ) : null;

  if (startingCredits || won) {
    const freeAfterCredits = includedModel?.free ? includedModel : null;
    const currency = startingCredits?.balance?.currency ?? "usd";
    const trialAmount = startingCredits?.balance
      ? formatCreditAmount(startingCredits.balance.balanceMicros, currency)
      : null;
    const wonAmount = won ? formatCreditAmount(won.amountMicros, "usd") : null;
    const heading = won
      ? won.free
        ? `You got ${wonAmount} in free credits`
        : `You added ${wonAmount} in credits`
      : trialAmount
        ? `You got ${trialAmount} in free credits`
        : "You got free Opengeni credits";
    const prizeMicros = won ? won.amountMicros : (startingCredits?.balance?.balanceMicros ?? null);
    return (
      <section className="og-page-glow flex min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <CelebrationBurst key={won?.celebration ?? 0} />
        <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          {prizeMicros !== null ? (
            <CreditsPrize
              key={won?.celebration ?? 0}
              amountMicros={prizeMicros}
              currency={won ? "usd" : currency}
              label={won ? (won.free ? "Coupon redeemed" : "Credits added") : "Free credits"}
              caption={
                won && won.balanceMicros !== null
                  ? `Your balance is now ${formatCreditAmount(won.balanceMicros, "usd")}`
                  : `Added to ${organizationName || "your organization"}`
              }
            />
          ) : null}
          <h1
            className={`text-xl font-semibold tracking-tight ${prizeMicros !== null ? "mt-6" : ""}`}
          >
            {heading}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {startingCredits
              ? `You can start right now. New chats use ${describeCreditsModel(startingCredits.model)}. No card or API key needed.`
              : "You can start right now. New chats use your Opengeni credits."}
          </p>
          {freeAfterCredits ? (
            <p className="mt-2 text-xs leading-relaxed text-fg-muted">
              When your credits run out, new chats use {freeAfterCredits.label}, which is free.
            </p>
          ) : null}
          <Button
            type="button"
            size="lg"
            className="mt-6 w-full"
            disabled={busy}
            onClick={leaveOnboarding}
          >
            {continueToNextStep ? "Continue" : "Start chatting"}
          </Button>
          {coupon ? <div className="mt-3 text-center">{coupon}</div> : null}

          <Disclosure
            className="mt-6 border-t border-border pt-3"
            title="Other ways to pay"
            summary={`Optional. Connect a subscription or API key${billingMode === "stripe" ? ", or buy more credits" : ""}. You can also do this later.`}
          >
            <div className="pt-2">{connectOptions}</div>
            {selectionRetryNotice}
          </Disclosure>
        </div>
      </section>
    );
  }

  if (includedModel) {
    return (
      <section className="flex min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">
            {includedModel.free ? "Start chatting for free" : "You’re ready to chat"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {includedModel.free
              ? `${modelDisplayName(includedModel)} is set up and free to use. No card or API key needed.`
              : `${modelDisplayName(includedModel)} is set up and included with this deployment.`}
          </p>
          <Button
            type="button"
            className="mt-6 h-10 w-full"
            disabled={busy}
            onClick={leaveOnboarding}
          >
            {continueToNextStep
              ? "Continue"
              : includedModel.free
                ? "Start chatting for free"
                : "Start chatting"}
          </Button>

          <div className="mt-8 border-t border-border pt-6">
            <h2 className="text-sm font-medium">Want a more capable model? (optional)</h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              Connect a subscription or API key you already have
              {billingMode === "stripe" ? ", or add Opengeni credits" : ""}. You can also do this
              later.
            </p>
            <div className="mt-3">{connectOptions}</div>
            {selectionRetryNotice}
            {coupon ? <div className="mt-4 text-center">{coupon}</div> : null}
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
          {billingMode === "stripe" ? ", or get started with Opengeni credits" : ""}.
        </p>

        <div className="mt-6">{connectOptions}</div>
        {selectionRetryNotice}
        {coupon ? <div className="mt-4 text-center">{coupon}</div> : null}
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
