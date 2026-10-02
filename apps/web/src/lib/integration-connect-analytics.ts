// Consent-gated integration connect journey (PostHog through
// `captureAnalyticsEvent`). Every connect flow for an integration,
// capability, or model provider reports
//
//   integration_connect_started{integration_class, method}
//   integration_connect_finished{integration_class, method, outcome}
//
// `integration_class` reuses the closed provider classes of the server
// lifecycle facts (`connection.created` and `model.connected` in
// @opengeni/contracts product-lifecycle-facts), so browser funnels join the
// server facts. Only closed values leave the browser: never a provider
// domain, account, URL, error text, or identifier.
//
// Outcomes: `connected`, `denied` (the person or provider refused
// authorization), `provider_error`, `cancelled` (the person cancelled or
// closed the authorization window), `abandoned` (best effort: the setup
// dialog was closed, the page was left, or the person came back from a
// provider redirect without an outcome), and `outcome_unknown`.
import type { PRODUCT_LIFECYCLE_FACT_ATTRIBUTES } from "@opengeni/contracts";
import { useCallback, useEffect, useRef } from "react";

import { captureAnalyticsEvent } from "./analytics-observer";
import {
  takeIntegrationConnectReturn,
  type IntegrationConnectReturn,
} from "./integration-connect-return";

type ConnectionClass = (typeof PRODUCT_LIFECYCLE_FACT_ATTRIBUTES)["connection.created"][number];
type ModelClass = (typeof PRODUCT_LIFECYCLE_FACT_ATTRIBUTES)["model.connected"][number];

/** The `connection.created` provider classes (a test keeps them identical). */
export const INTEGRATION_CONNECTION_CLASSES = [
  "slack",
  "github",
  "gitlab",
  "azure_devops",
  "bitbucket",
  "google",
  "microsoft",
  "linear",
  "atlassian",
  "notion",
  "supabase",
  "datadog",
  "posthog",
  "openai",
  "x",
  "other",
] as const satisfies readonly ConnectionClass[];

/** The `model.connected` provider classes (a test keeps them identical). */
export const MODEL_CONNECTION_CLASSES = [
  "codex",
  "supergrok",
  "vercel_gateway",
  "openrouter",
  "anthropic",
  "claude_subscription",
] as const satisfies readonly ModelClass[];

export type IntegrationClass = ConnectionClass | ModelClass;

export const INTEGRATION_CONNECT_METHODS = [
  "oauth",
  "api_key",
  "device_code",
  "app_install",
  "custom",
] as const;
export type IntegrationConnectMethod = (typeof INTEGRATION_CONNECT_METHODS)[number];

export const INTEGRATION_CONNECT_OUTCOMES = [
  "connected",
  "denied",
  "provider_error",
  "cancelled",
  "abandoned",
  "outcome_unknown",
] as const;
export type IntegrationConnectOutcome = (typeof INTEGRATION_CONNECT_OUTCOMES)[number];

const DOMAIN_CLASSES: ReadonlyArray<readonly [ConnectionClass, readonly string[]]> = [
  ["slack", ["slack.com"]],
  ["github", ["github.com"]],
  ["gitlab", ["gitlab.com"]],
  ["azure_devops", ["dev.azure.com", "visualstudio.com"]],
  ["bitbucket", ["bitbucket.org"]],
  ["google", ["google.com", "googleapis.com"]],
  ["microsoft", ["microsoft.com", "office.com", "microsoftonline.com"]],
  ["linear", ["linear.app"]],
  ["atlassian", ["atlassian.com", "atlassian.net"]],
  ["notion", ["notion.so", "notion.com"]],
  ["supabase", ["supabase.com", "supabase.co"]],
  ["datadog", ["datadoghq.com", "datadog.com", "datadoghq.eu"]],
  ["posthog", ["posthog.com"]],
  ["openai", ["openai.com", "chatgpt.com"]],
  ["x", ["x.com", "twitter.com"]],
];

/**
 * The provider class of a connection domain or MCP host, mirroring
 * `opengeni_private.product_lifecycle_connection_class` (migration 0532).
 */
export function integrationClassFromDomain(domain: string | null | undefined): ConnectionClass {
  let host = (domain ?? "").trim().toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host).hostname;
  } catch {
    return "other";
  }
  for (const [integrationClass, roots] of DOMAIN_CLASSES) {
    if (
      roots.some((root) =>
        integrationClass === "azure_devops" && root === "dev.azure.com"
          ? host === root
          : host === root || host.endsWith(`.${root}`),
      )
    ) {
      return integrationClass;
    }
  }
  return "other";
}

const CONNECT_PROVIDER_CLASSES: ReadonlyArray<readonly [RegExp, ConnectionClass]> = [
  [/^slack(-|$)/, "slack"],
  [/^github(-|$)/, "github"],
  [/^(google-drive|gmail)(-|$)/, "google"],
  [/^(microsoft|outlook|onedrive)(-|$)/, "microsoft"],
  [/^atlassian(-|$)/, "atlassian"],
  [/^x$/, "x"],
];

/** The provider class of a Connect API `providerId` (for example `slack-bot`). */
export function integrationClassFromConnectProvider(providerId: string): ConnectionClass {
  return CONNECT_PROVIDER_CLASSES.find(([pattern]) => pattern.test(providerId))?.[1] ?? "other";
}

/** The `model.connected` class of a model provider name used in the console. */
export function modelConnectionClass(provider: string): ModelClass | null {
  switch (provider) {
    case "codex":
    case "supergrok":
    case "openrouter":
    case "anthropic":
    case "claude_subscription":
      return provider;
    case "ai-gateway":
    case "vercel_gateway":
    case "vercel_ai_gateway":
    case "gateway":
      return "vercel_gateway";
    default:
      return null;
  }
}

/** The outcome of a failed connect request or authorization. */
export function integrationConnectErrorOutcome(error: unknown): IntegrationConnectOutcome {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "AbortError" || name === "ConnectPopupClosedError") return "cancelled";
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number" && status >= 400 && status < 600) return "provider_error";
  return "outcome_unknown";
}

/** The outcome of a settled Connect API attempt, or null while it is still in progress. */
export function connectAttemptOutcome(attempt: {
  state: string;
  error?: { code: string } | undefined;
}): IntegrationConnectOutcome | null {
  switch (attempt.state) {
    case "complete":
      return "connected";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "abandoned";
    case "uncertain":
      return "outcome_unknown";
    case "failed":
      return /denied/i.test(attempt.error?.code ?? "") ? "denied" : "provider_error";
    default:
      return null;
  }
}

export type IntegrationConnectTracker = {
  /** Report the outcome. Only the first call reports. */
  finish(outcome: IntegrationConnectOutcome): void;
  /**
   * The page is about to leave for the provider. The journey finishes when
   * the browser returns (see `captureIntegrationConnectReturn`), so leaving
   * the page is not reported as `abandoned`.
   */
  redirecting(options?: { returnsWithOutcome?: boolean }): void;
};

type Capture = (
  name: "integration_connect_started" | "integration_connect_finished",
  properties: Record<string, string>,
) => boolean;

const REDIRECT_MARKER_KEY = "opengeni.analytics.integrationConnect";
const REDIRECT_MARKER_MAX_AGE_MS = 60 * 60_000;
type RedirectMarker = {
  integrationClass: IntegrationClass;
  method: IntegrationConnectMethod;
  returnsWithOutcome: boolean;
  startedAt: number;
};

const pending = new Set<{ abandon(): void }>();
let pageHideInstalled = false;

function installPageHide(): void {
  if (pageHideInstalled || typeof window === "undefined") return;
  pageHideInstalled = true;
  window.addEventListener("pagehide", () => {
    for (const tracker of [...pending]) tracker.abandon();
  });
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Start a connect journey. `capture` defaults to the consent-gated product
 * analytics; when collection is not allowed nothing is reported or stored.
 */
export function beginIntegrationConnect(
  integrationClass: IntegrationClass,
  method: IntegrationConnectMethod,
  options: { capture?: Capture; storage?: Storage | null; now?: () => number } = {},
): IntegrationConnectTracker {
  const capture: Capture = options.capture ?? captureAnalyticsEvent;
  const properties = { integration_class: integrationClass, method };
  let accepted = false;
  try {
    accepted = capture("integration_connect_started", properties);
  } catch {
    accepted = false;
  }
  let settled = false;
  const entry = { abandon: () => finish("abandoned") };
  function finish(outcome: IntegrationConnectOutcome) {
    if (settled) return;
    settled = true;
    pending.delete(entry);
    if (!accepted) return;
    try {
      capture("integration_connect_finished", { ...properties, outcome });
    } catch {
      // Optional telemetry cannot fail product work.
    }
  }
  if (accepted) {
    pending.add(entry);
    installPageHide();
  }
  return {
    finish,
    redirecting({ returnsWithOutcome = true } = {}) {
      if (settled) return;
      settled = true;
      pending.delete(entry);
      if (!accepted) return;
      const marker: RedirectMarker = {
        integrationClass,
        method,
        returnsWithOutcome,
        startedAt: (options.now ?? Date.now)(),
      };
      try {
        (options.storage === undefined ? sessionStore() : options.storage)?.setItem(
          REDIRECT_MARKER_KEY,
          JSON.stringify(marker),
        );
      } catch {
        // Without the marker the return still reports its outcome as `other`.
      }
    },
  };
}

function readRedirectMarker(storage: Storage | null, now: number): RedirectMarker | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(REDIRECT_MARKER_KEY);
    storage.removeItem(REDIRECT_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const marker = JSON.parse(raw) as Partial<RedirectMarker>;
    const known: readonly string[] = [
      ...INTEGRATION_CONNECTION_CLASSES,
      ...MODEL_CONNECTION_CLASSES,
    ];
    if (
      typeof marker.integrationClass !== "string" ||
      !known.includes(marker.integrationClass) ||
      !INTEGRATION_CONNECT_METHODS.includes(marker.method as IntegrationConnectMethod) ||
      typeof marker.startedAt !== "number" ||
      now - marker.startedAt > REDIRECT_MARKER_MAX_AGE_MS
    ) {
      return null;
    }
    return marker as RedirectMarker;
  } catch {
    return null;
  }
}

const RETURN_CLASSES: Partial<Record<IntegrationConnectReturn["parameter"], ConnectionClass>> = {
  slack: "slack",
  google_drive: "google",
  atlassian: "atlassian",
  github_personal_oauth: "github",
  github: "github",
};

/** The closed outcome of a provider return parameter. */
export function integrationConnectReturnOutcome(
  value: IntegrationConnectReturn,
): IntegrationConnectOutcome {
  if (["success", "connected", "complete"].includes(value.status)) return "connected";
  const reason = value.reason ?? "";
  if (/denied/i.test(reason)) return "denied";
  if (/cancel/i.test(reason)) return "cancelled";
  if (/^(state_expired|missing_code)$/.test(reason)) return "abandoned";
  if (/timeout/i.test(reason)) return "outcome_unknown";
  return "provider_error";
}

/**
 * Finish a redirect connect journey once analytics collection is active:
 * report the outcome of the provider return parameters this document loaded
 * with, or `abandoned` (`outcome_unknown` for flows whose return carries no
 * outcome) when a redirect started in this tab and the person came back
 * without one.
 */
export function captureIntegrationConnectReturn(
  options: {
    returned?: IntegrationConnectReturn | null;
    capture?: Capture;
    storage?: Storage | null;
    now?: () => number;
  } = {},
): void {
  const returned =
    options.returned === undefined ? takeIntegrationConnectReturn() : options.returned;
  const marker = readRedirectMarker(
    options.storage === undefined ? sessionStore() : options.storage,
    (options.now ?? Date.now)(),
  );
  if (!returned && !marker) return;
  const capture: Capture = options.capture ?? captureAnalyticsEvent;
  const integrationClass: IntegrationClass =
    marker?.integrationClass ??
    (returned
      ? (RETURN_CLASSES[returned.parameter] ??
        (returned.providerDomain ? integrationClassFromDomain(returned.providerDomain) : "other"))
      : "other");
  const outcome: IntegrationConnectOutcome = returned
    ? integrationConnectReturnOutcome(returned)
    : marker?.returnsWithOutcome
      ? "abandoned"
      : "outcome_unknown";
  try {
    capture("integration_connect_finished", {
      integration_class: integrationClass,
      method: marker?.method ?? (returned?.parameter === "github" ? "app_install" : "oauth"),
      outcome,
    });
  } catch {
    // Optional telemetry cannot fail product work.
  }
}

/**
 * A connect journey bound to a mounted setup surface: started on mount,
 * `abandoned` when it unmounts before `finish` was called.
 */
export function useIntegrationConnectJourney(
  integrationClass: IntegrationClass,
  method: IntegrationConnectMethod,
): (outcome: IntegrationConnectOutcome) => void {
  const tracker = useRef<IntegrationConnectTracker | null>(null);
  useEffect(() => {
    const started = beginIntegrationConnect(integrationClass, method);
    tracker.current = started;
    return () => {
      started.finish("abandoned");
      if (tracker.current === started) tracker.current = null;
    };
  }, [integrationClass, method]);
  return useCallback((outcome) => tracker.current?.finish(outcome), []);
}

/**
 * A model-provider connect journey with the outcome vocabulary of
 * `trackModelConnection`, for flows that have no workspace-scoped tracker
 * (organization connections, Claude). `expired` is reported as `abandoned`.
 */
export function beginModelConnectJourney(
  provider: string,
  method: IntegrationConnectMethod,
): (outcome: "connected" | "expired" | "denied" | "outcome_unknown") => void {
  const tracker = beginIntegrationConnect(modelConnectionClass(provider) ?? "other", method);
  return (outcome) => tracker.finish(outcome === "expired" ? "abandoned" : outcome);
}
