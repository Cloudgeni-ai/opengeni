import { analyticsHasProviders, storedAnalyticsConsent } from "@/lib/analytics-consent";
import type { AnalyticsConsent } from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";

export type AnalyticsEventName =
  | "signed_up"
  | "workspace_created"
  | "integration_connected"
  | "session_started"
  | "session_completed"
  | "subscription_started";

type AnalyticsConfig = ClientConfig["analytics"];
type AnalyticsProperty = boolean | number | string;
type AnalyticsProperties = Record<string, AnalyticsProperty>;
type PostHogClient = typeof import("posthog-js").default;
type ReoClient = {
  init: (config: { clientID: string; dnt: string[] }) => void;
  unload?: () => void;
};

const REO_SCRIPT_ID = "opengeni-analytics-reo";
const GA4_SCRIPT_ID = "opengeni-analytics-ga4";
const EXTERNAL_SCRIPT_TIMEOUT_MS = 10_000;

let activeConfig: AnalyticsConfig | null = null;
let initialization: Promise<void> | null = null;
let initializationGeneration = 0;
let providersReady = false;
let posthogClient: PostHogClient | null = null;
let ga4MeasurementId: string | null = null;
let latestPathname: string | null = null;
let suspended = false;

declare global {
  interface Window {
    Reo?: ReoClient;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function syncAnalytics(config: AnalyticsConfig, pathname: string): void {
  suspended = false;
  activeConfig = config;
  latestPathname = pathname;
  if (!analyticsCollectionAllowed()) {
    return;
  }
  if (initialization) {
    if (providersReady) {
      dispatchPageView(pathname);
    }
    return;
  }
  void initializeProviders(config);
}

export function suspendAnalytics(): void {
  suspended = true;
  stopProviders();
}

export function applyAnalyticsConsent(consent: AnalyticsConsent): void {
  if (consent === "granted" && activeConfig && !suspended) {
    void initializeProviders(activeConfig);
    return;
  }
  if (consent === "denied") {
    stopProviders();
  }
}

export function captureAnalyticsEvent(
  name: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): void {
  if (!analyticsCollectionAllowed()) {
    return;
  }
  posthogClient?.capture(name, properties);
  window.gtag?.("event", name, properties);
}

async function initializeProviders(config: AnalyticsConfig): Promise<void> {
  if (initialization) {
    return await initialization;
  }
  const generation = initializationGeneration;
  initialization = Promise.allSettled([
    config.providers.reo ? initializeReo(config.providers.reo.clientId) : Promise.resolve(),
    config.providers.posthog
      ? initializePostHog(config.providers.posthog.projectKey, config.providers.posthog.host)
      : Promise.resolve(),
    config.providers.ga4 ? initializeGa4(config.providers.ga4.measurementId) : Promise.resolve(),
  ]).then(() => {
    if (generation === initializationGeneration && latestPathname && analyticsCollectionAllowed()) {
      providersReady = true;
      dispatchPageView(latestPathname);
    }
  });
  await initialization;
}

function analyticsCollectionAllowed(): boolean {
  if (suspended || !activeConfig || !analyticsHasProviders(activeConfig)) {
    return false;
  }
  const consent = storedAnalyticsConsent();
  return consent === "granted" || (!activeConfig.consentRequired && consent !== "denied");
}

function dispatchPageView(pathname: string): void {
  posthogClient?.capture("$pageview", { $current_url: pathname });
  if (ga4MeasurementId) {
    window.gtag?.("event", "page_view", {
      page_location: `${window.location.origin}${pathname}`,
      send_to: ga4MeasurementId,
    });
  }
}

async function initializeReo(clientId: string): Promise<void> {
  if (!analyticsCollectionAllowed()) {
    return;
  }
  if (!window.Reo) {
    document.getElementById(REO_SCRIPT_ID)?.remove();
    const script = document.createElement("script");
    script.id = REO_SCRIPT_ID;
    script.async = true;
    script.src = `https://static.reo.dev/${encodeURIComponent(clientId)}/reo.js`;
    await appendExternalScript(script);
  }
  if (!analyticsCollectionAllowed() || !window.Reo) {
    return;
  }
  window.Reo.init({
    clientID: clientId,
    // Reo's beacon otherwise observes clipboard/code-copy and supported AI-widget
    // interactions. OpenGeni deliberately permits page intent only.
    dnt: ["copy", "ai"],
  });
}

async function initializePostHog(projectKey: string, host: string): Promise<void> {
  if (posthogClient) {
    posthogClient.opt_in_capturing();
    return;
  }
  const { default: posthog } = await import("posthog-js");
  if (!analyticsCollectionAllowed()) {
    return;
  }
  posthog.init(projectKey, {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
  });
  posthogClient = posthog;
}

async function initializeGa4(measurementId: string): Promise<void> {
  if (!analyticsCollectionAllowed()) {
    return;
  }
  window.dataLayer ??= [];
  window.gtag ??= (...args: unknown[]) => {
    window.dataLayer?.push(args);
  };
  window.gtag("consent", "update", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  ga4MeasurementId = measurementId;
  if (document.getElementById(GA4_SCRIPT_ID)) {
    return;
  }
  window.gtag("js", new Date());
  window.gtag("config", measurementId, {
    allow_google_signals: false,
    send_page_view: false,
  });

  const script = document.createElement("script");
  script.id = GA4_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.append(script);
}

function stopProviders(): void {
  initializationGeneration += 1;
  initialization = null;
  providersReady = false;
  try {
    window.Reo?.unload?.();
  } catch {
    // Third-party cleanup must never break the product UI.
  }
  posthogClient?.opt_out_capturing();
  window.gtag?.("consent", "update", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
}

function appendExternalScript(script: HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("Analytics provider script timed out"));
    }, EXTERNAL_SCRIPT_TIMEOUT_MS);
    script.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        script.remove();
        reject(new Error("Analytics provider script failed to load"));
      },
      { once: true },
    );
    document.head.append(script);
  });
}
