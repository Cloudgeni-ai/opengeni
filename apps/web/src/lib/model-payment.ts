import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { formatMoneyMicros } from "./format";

/**
 * "How do you want to pay for models?" as data: one list, in one order, with
 * the same words in onboarding, the composer's Connect a model menu,
 * Organization > Models > Connect account, the failed-session banner and the
 * out-of-credits prompt. Each place decides what choosing a row does; the
 * choices, their wording and their truthful states come from here.
 */
export type ModelPaymentOptionId = "credits" | "codex" | "supergrok" | "gateway" | "openrouter";

export type ModelPaymentState =
  /** The person can choose it here. */
  | "available"
  /** The deployment doesn't offer it. */
  | "unavailable"
  /** Someone else has to do it (permissions). */
  | "ask_admin";

export type ModelPaymentOption = Readonly<{
  id: ModelPaymentOptionId;
  title: string;
  description: string;
  state: ModelPaymentState;
  /** Why it isn't available, or who can do it. */
  reason: string | null;
  /** A quiet fact after the title: the credits balance. */
  meta: string | null;
  /** One of the two headline choices (credits and the ChatGPT plan). */
  featured: boolean;
}>;

export type ModelPaymentFacts = Readonly<{
  /** The deployment sells Opengeni credits (Stripe billing). */
  billingMode: "disabled" | "stripe";
  /** `billing:manage` on the organization (owners). */
  canBuyCredits: boolean;
  /** Organization owners and admins connect subscriptions and keys. */
  canConnectAccounts: boolean;
  codexEnabled: boolean;
  supergrokEnabled: boolean;
  /** The organization's credit balance, when known. */
  balance: { balanceMicros: number; currency: string } | null;
  /** "5%": the markup on the provider's price, when every credits model agrees. */
  creditsMargin: string | null;
  /** Which headline choice leads: credits for building, the ChatGPT plan for cloud work. */
  lead: "credits" | "codex";
}>;

/**
 * The markup every credits-billed model in this catalog charges on the
 * provider's price ("5%"), or null when the catalog doesn't say or models
 * disagree. Built-in schedules use +5%; operators may configure another.
 */
export function creditsMarginLabel(
  models: readonly Pick<WorkspaceModelCatalogModel, "cost" | "pricing">[],
): string | null {
  const margins = new Set(
    models
      .filter((model) => model.cost === "credits" && model.pricing)
      .map((model) => model.pricing?.default.marginBps ?? 0),
  );
  if (margins.size !== 1) return null;
  const [bps] = [...margins];
  if (bps === undefined || bps <= 0) return null;
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** What credits cost, in one plain sentence. */
export function creditsPriceSentence(margin: string | null): string {
  return margin
    ? `Pay as you go: the model provider's price plus ${margin}. No provider account needed.`
    : "Pay as you go: the model provider's price plus a small fee. No provider account needed.";
}

export const CREDITS_UNAVAILABLE_REASON =
  "Not available on this server. Buying credits needs Stripe billing, which it hasn't turned on.";
export const CREDITS_ASK_OWNER_REASON = "Ask an organization owner to add credits.";
export const CONNECT_ASK_ADMIN_REASON =
  "Only organization owners and admins can connect accounts. Ask one to connect it.";
export const NOT_ENABLED_REASON = "Not enabled on this server.";

export function modelPaymentOptions(facts: ModelPaymentFacts): ModelPaymentOption[] {
  const balance =
    facts.balance && facts.balance.balanceMicros > 0
      ? `${formatMoneyMicros(facts.balance.balanceMicros, facts.balance.currency)} left`
      : null;
  const credits: ModelPaymentOption = {
    id: "credits",
    title: "Opengeni credits",
    description: creditsPriceSentence(facts.creditsMargin),
    ...(facts.billingMode !== "stripe"
      ? { state: "unavailable" as const, reason: CREDITS_UNAVAILABLE_REASON }
      : facts.canBuyCredits
        ? { state: "available" as const, reason: null }
        : { state: "ask_admin" as const, reason: CREDITS_ASK_OWNER_REASON }),
    meta: balance,
    featured: true,
  };
  const connectState = (enabled: boolean) =>
    !enabled
      ? { state: "unavailable" as const, reason: NOT_ENABLED_REASON }
      : facts.canConnectAccounts
        ? { state: "available" as const, reason: null }
        : { state: "ask_admin" as const, reason: CONNECT_ASK_ADMIN_REASON };
  const codex: ModelPaymentOption = {
    id: "codex",
    title: "Your ChatGPT plan",
    description: "Sign in with ChatGPT once. Opengeni doesn't charge for it.",
    ...connectState(facts.codexEnabled),
    meta: null,
    featured: true,
  };
  const others: ModelPaymentOption[] = [
    {
      id: "supergrok",
      title: "SuperGrok",
      description: "Use your xAI subscription. Opengeni doesn't charge for it.",
      ...connectState(facts.supergrokEnabled),
      meta: null,
      featured: false,
    },
    {
      id: "gateway",
      title: "Vercel AI Gateway",
      description: "Your own API key. You pay Vercel directly.",
      ...connectState(true),
      meta: null,
      featured: false,
    },
    {
      id: "openrouter",
      title: "OpenRouter",
      description: "Your own API key. You pay OpenRouter directly.",
      ...connectState(true),
      meta: null,
      featured: false,
    },
  ];
  // A subscription the deployment doesn't offer at all is noise outside the
  // Connect page; keep it there (DESIGN: "Not enabled on this server").
  return [...(facts.lead === "credits" ? [credits, codex] : [codex, credits]), ...others];
}

/**
 * Stripe checkout accepts promotion codes ("Have a gift code? Enter it at
 * checkout."). Off until the server says checkout accepts them; the credits
 * form already leaves the line's place.
 */
export function checkoutAcceptsPromotionCodes(config: object | null): boolean {
  const billing = (config as { billing?: { promotionCodes?: unknown } } | null)?.billing;
  return billing?.promotionCodes === true;
}
