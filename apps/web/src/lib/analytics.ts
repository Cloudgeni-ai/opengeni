import type { ClientConfig } from "@/types";

export type AnalyticsConsent = "granted" | "denied";
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

const CONSENT_STORAGE_KEY = "opengeni.analyticsConsent";
const REO_SCRIPT_ID = "opengeni-analytics-reo";
const GA4_SCRIPT_ID = "opengeni-analytics-ga4";

let activeConfig: AnalyticsConfig | null = null;
let initialization: Promise<void> | null = null;
let posthogClient: PostHogClient | null = null;
let ga4MeasurementId: string | null = null;
let latestPathname: string | null = null;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function analyticsHasProviders(config: AnalyticsConfig | null | undefined): boolean {
  if (!config) {
    return false;
  }
  return Object.values(config.providers).some(Boolean);
}

export function storedAnalyticsConsent(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): AnalyticsConsent | null {
  const value = storage?.getItem(CONSENT_STORAGE_KEY);
  return value === "granted" || value === "denied" ? value : null;
}

export function configureAnalytics(config: AnalyticsConfig): void {
  activeConfig = config;
  if (!analyticsHasProviders(config)) {
    return;
  }
  const consent = storedAnalyticsConsent();
  if (consent === "granted" || (!config.consentRequired && consent !== "denied")) {
    void initializeProviders(config);
  }
}

export function setAnalyticsConsent(
  consent: AnalyticsConsent,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): void {
  storage?.setItem(CONSENT_STORAGE_KEY, consent);
  if (consent === "granted" && activeConfig) {
    void initializeProviders(activeConfig);
    return;
  }
  if (consent === "denied") {
    posthogClient?.opt_out_capturing();
    window.gtag?.("consent", "update", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }
}

export function trackAnalyticsPage(pathname: string): void {
  latestPathname = pathname;
  if (!analyticsCollectionAllowed()) {
    return;
  }
  dispatchPageView(pathname);
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
  initialization = Promise.allSettled([
    config.providers.reo ? initializeReo(config.providers.reo.clientId) : Promise.resolve(),
    config.providers.posthog
      ? initializePostHog(config.providers.posthog.projectKey, config.providers.posthog.host)
      : Promise.resolve(),
    config.providers.ga4 ? initializeGa4(config.providers.ga4.measurementId) : Promise.resolve(),
  ]).then(() => {
    if (latestPathname) {
      dispatchPageView(latestPathname);
    }
  });
  await initialization;
}

function analyticsCollectionAllowed(): boolean {
  if (!activeConfig || !analyticsHasProviders(activeConfig)) {
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
  if (document.getElementById(REO_SCRIPT_ID)) {
    return;
  }
  const script = document.createElement("script");
  script.id = REO_SCRIPT_ID;
  script.async = true;
  script.src = `https://static.reo.dev/${encodeURIComponent(clientId)}/reo.js`;
  document.head.append(script);
}

async function initializePostHog(projectKey: string, host: string): Promise<void> {
  const { default: posthog } = await import("posthog-js");
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
  if (document.getElementById(GA4_SCRIPT_ID)) {
    return;
  }
  window.dataLayer ??= [];
  window.gtag ??= (...args: unknown[]) => {
    window.dataLayer?.push(args);
  };
  window.gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  window.gtag("js", new Date());
  window.gtag("config", measurementId, {
    allow_google_signals: false,
    send_page_view: false,
  });
  ga4MeasurementId = measurementId;

  const script = document.createElement("script");
  script.id = GA4_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.append(script);
}
