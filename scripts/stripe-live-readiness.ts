type TopupPackageId = "25" | "100" | "500" | "1000";

type StripeAccount = {
  id?: string;
  object?: string;
  country?: string;
  default_currency?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
};

type StripeProduct = {
  id?: string;
  object?: string;
  active?: boolean;
  name?: string;
  metadata?: Record<string, string>;
};

type StripePrice = {
  id?: string;
  object?: string;
  active?: boolean;
  currency?: string;
  type?: string;
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  product?: string | StripeProduct;
  metadata?: Record<string, string>;
};

type StripeWebhookEndpoint = {
  id?: string;
  object?: string;
  url?: string;
  status?: string;
  enabled_events?: string[];
  livemode?: boolean;
};

type StripeList<T> = {
  object?: string;
  data?: T[];
  has_more?: boolean;
};

type CheckStatus = "passed" | "failed";

type CheckResult = {
  id: string;
  status: CheckStatus;
  detail: string;
};

const topupPackages: Record<TopupPackageId, { env: string; cents: number; label: string }> = {
  "25": { env: "OPENGENI_STRIPE_LIVE_TOPUP_PRICE_25", cents: 2_500, label: "$25" },
  "100": { env: "OPENGENI_STRIPE_LIVE_TOPUP_PRICE_100", cents: 10_000, label: "$100" },
  "500": { env: "OPENGENI_STRIPE_LIVE_TOPUP_PRICE_500", cents: 50_000, label: "$500" },
  "1000": { env: "OPENGENI_STRIPE_LIVE_TOPUP_PRICE_1000", cents: 100_000, label: "$1,000" },
};

const requiredWebhookEvents = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
  "charge.dispute.updated",
  "customer.created",
  "customer.updated",
];

interface Args {
  secretKey: string;
  publishableKey: string;
  apiBaseUrl: string;
  webhookUrl: string;
  currency: string;
  priceIds: Record<TopupPackageId, string>;
  stripeVersion?: string;
}

const args = parseArgs(process.argv.slice(2), process.env);
const results: CheckResult[] = [];
let account: StripeAccount | null = null;
const prices: Record<string, unknown> = {};
let webhookEndpoint: StripeWebhookEndpoint | null = null;

await runCheck("live-secret-key", async () => {
  if (!args.secretKey.startsWith("sk_live_")) {
    throw new Error("expected STRIPE_LIVE_SECRET_KEY or OPENGENI_STRIPE_SECRET_KEY to start with sk_live_");
  }
  return "live secret key prefix is sk_live_";
});

await runCheck("live-publishable-key", async () => {
  if (!args.publishableKey.startsWith("pk_live_")) {
    throw new Error("expected STRIPE_LIVE_PUBLISHABLE_KEY or OPENGENI_STRIPE_PUBLISHABLE_KEY to start with pk_live_");
  }
  return "live publishable key prefix is pk_live_";
});

await runCheck("account-readiness", async () => {
  account = await stripeGet<StripeAccount>(args, "/v1/account");
  const accountId = stringField(account.id, "account.id");
  if (!accountId.startsWith("acct_")) {
    throw new Error(`unexpected Stripe account id ${accountId}`);
  }
  if (account.charges_enabled !== true) {
    throw new Error("account charges_enabled is not true");
  }
  if (account.payouts_enabled !== true) {
    throw new Error("account payouts_enabled is not true");
  }
  if (account.details_submitted !== true) {
    throw new Error("account details_submitted is not true");
  }
  return `account ${accountId} is charges/payouts/details ready`;
});

for (const [packageId, config] of Object.entries(topupPackages) as Array<[TopupPackageId, typeof topupPackages[TopupPackageId]]>) {
  await runCheck(`price-${packageId}`, async () => {
    const priceId = args.priceIds[packageId];
    if (!priceId) {
      throw new Error(`missing ${config.env}`);
    }
    if (!priceId.startsWith("price_")) {
      throw new Error(`${config.env} must start with price_`);
    }
    const price = await stripeGet<StripePrice>(args, `/v1/prices/${encodeURIComponent(priceId)}`, { "expand[]": "product" });
    prices[packageId] = sanitizePrice(price);
    if (price.active !== true) {
      throw new Error(`${config.env} price is not active`);
    }
    if ((price.currency ?? "").toLowerCase() !== args.currency) {
      throw new Error(`${config.env} currency is ${price.currency ?? "<missing>"}, expected ${args.currency}`);
    }
    if (price.type !== "one_time") {
      throw new Error(`${config.env} type is ${price.type ?? "<missing>"}, expected one_time`);
    }
    const cents = typeof price.unit_amount === "number" ? price.unit_amount : Number(price.unit_amount_decimal);
    if (cents !== config.cents) {
      throw new Error(`${config.env} unit amount is ${cents}, expected ${config.cents}`);
    }
    const product = typeof price.product === "object" && price.product ? price.product : null;
    if (product && product.active !== true) {
      throw new Error(`${config.env} product is not active`);
    }
    return `${config.label} live top-up price ${priceId} is active ${args.currency}`;
  });
}

await runCheck("webhook-endpoint", async () => {
  const endpoints = await listWebhookEndpoints(args);
  webhookEndpoint = endpoints.find((endpoint) => endpoint.url === args.webhookUrl) ?? null;
  if (!webhookEndpoint) {
    throw new Error(`no live webhook endpoint found for ${args.webhookUrl}`);
  }
  if (webhookEndpoint.livemode !== true) {
    throw new Error("webhook endpoint livemode is not true");
  }
  if (webhookEndpoint.status !== "enabled") {
    throw new Error(`webhook endpoint status is ${webhookEndpoint.status ?? "<missing>"}, expected enabled`);
  }
  const enabledEvents = webhookEndpoint.enabled_events ?? [];
  if (!enabledEvents.includes("*")) {
    const missing = requiredWebhookEvents.filter((event) => !enabledEvents.includes(event));
    if (missing.length > 0) {
      throw new Error(`webhook endpoint is missing events: ${missing.join(", ")}`);
    }
  }
  return `webhook endpoint ${webhookEndpoint.id ?? "<unknown>"} covers OpenGeni Stripe events`;
});

const ok = !results.some((result) => result.status === "failed");
console.log(JSON.stringify({
  ok,
  mode: "live-readonly",
  account: account ? sanitizeAccount(account) : null,
  currency: args.currency,
  webhookUrl: args.webhookUrl,
  webhookEndpoint: webhookEndpoint ? sanitizeWebhook(webhookEndpoint) : null,
  prices,
  results,
}, null, 2));

if (!ok) {
  process.exit(1);
}

async function runCheck(id: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ id, status: "passed", detail: await fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

async function stripeGet<T>(args: Args, path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, args.apiBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.append(key, value);
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${args.secretKey}`,
      ...(args.stripeVersion ? { "stripe-version": args.stripeVersion } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${redactStripeError(text)}`);
  }
  return JSON.parse(text) as T;
}

async function listWebhookEndpoints(args: Args): Promise<StripeWebhookEndpoint[]> {
  const endpoints: StripeWebhookEndpoint[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const payload = await stripeGet<StripeList<StripeWebhookEndpoint>>(args, "/v1/webhook_endpoints", {
      limit: "100",
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = payload.data ?? [];
    endpoints.push(...data);
    if (!payload.has_more || data.length === 0) {
      break;
    }
    startingAfter = data[data.length - 1]?.id ?? null;
    if (!startingAfter) {
      break;
    }
  }
  return endpoints;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out = {
    secretKey: env.STRIPE_LIVE_SECRET_KEY || liveOnly(env.OPENGENI_STRIPE_SECRET_KEY) || "",
    publishableKey: env.STRIPE_LIVE_PUBLISHABLE_KEY || liveOnly(env.OPENGENI_STRIPE_PUBLISHABLE_KEY) || "",
    apiBaseUrl: env.OPENGENI_STRIPE_API_BASE_URL || "https://api.stripe.com",
    webhookUrl: env.OPENGENI_STRIPE_LIVE_WEBHOOK_URL || `${(env.OPENGENI_PRODUCTION_FINAL_BASE_URL || "https://app.opengeni.ai").replace(/\/+$/, "")}/v1/webhooks/stripe`,
    currency: (env.OPENGENI_STRIPE_LIVE_CURRENCY || "usd").toLowerCase(),
    stripeVersion: env.OPENGENI_STRIPE_API_VERSION || undefined,
    priceIds: {
      "25": env.OPENGENI_STRIPE_LIVE_TOPUP_PRICE_25 || "",
      "100": env.OPENGENI_STRIPE_LIVE_TOPUP_PRICE_100 || "",
      "500": env.OPENGENI_STRIPE_LIVE_TOPUP_PRICE_500 || "",
      "1000": env.OPENGENI_STRIPE_LIVE_TOPUP_PRICE_1000 || "",
    },
  } satisfies Args;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--secret-key") {
      out.secretKey = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--publishable-key") {
      out.publishableKey = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--api-base-url") {
      out.apiBaseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--webhook-url") {
      out.webhookUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--currency") {
      out.currency = requiredNext(values, ++index, value).toLowerCase();
      continue;
    }
    if (value === "--stripe-version") {
      out.stripeVersion = requiredNext(values, ++index, value);
      continue;
    }
    const priceMatch = value.match(/^--price-(25|100|500|1000)$/);
    if (priceMatch) {
      out.priceIds[priceMatch[1] as TopupPackageId] = requiredNext(values, ++index, value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}

function liveOnly(value: string | undefined): string {
  return value?.startsWith("sk_live_") || value?.startsWith("pk_live_") ? value : "";
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function sanitizeAccount(account: StripeAccount): Record<string, unknown> {
  return {
    id: account.id,
    country: account.country,
    default_currency: account.default_currency,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    details_submitted: account.details_submitted,
  };
}

function sanitizePrice(price: StripePrice): Record<string, unknown> {
  const product = typeof price.product === "object" && price.product ? price.product : null;
  return {
    id: price.id,
    active: price.active,
    currency: price.currency,
    type: price.type,
    unit_amount: price.unit_amount,
    product: product ? {
      id: product.id,
      active: product.active,
      name: product.name,
      metadata: product.metadata,
    } : price.product,
    metadata: price.metadata,
  };
}

function sanitizeWebhook(endpoint: StripeWebhookEndpoint): Record<string, unknown> {
  return {
    id: endpoint.id,
    url: endpoint.url,
    status: endpoint.status,
    livemode: endpoint.livemode,
    enabled_events: endpoint.enabled_events,
  };
}

function redactStripeError(text: string): string {
  return text.replace(/(sk|pk|whsec)_(test|live)_[A-Za-z0-9_]+/g, "$1_$2_<redacted>");
}
