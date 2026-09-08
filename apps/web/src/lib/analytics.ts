import { installAnalyticsObserver } from "./analytics-observer";
import { clearLoginAnalytics, takeSuccessfulLogin } from "./analytics-login";
import {
  ANALYTICS_COLLECTION_ENABLED_EVENT,
  analyticsHasProviders,
  storedAnalyticsConsent,
} from "@/lib/analytics-consent";
import type { AnalyticsConsent } from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";
import { journeyOperation, journeyOutcome, journeyPage } from "./analytics-journey";

export type AnalyticsEventName =
  | "signup_submitted"
  | "workspace_created"
  | "session_started"
  | "login_completed"
  | "app_opened"
  | "app_active"
  | "navigation_clicked"
  | "product_clicked"
  | "credits_required_viewed"
  | "session_start_blocked"
  | "session_start_blocker_viewed"
  | "session_create_attempted"
  | "session_create_finished"
  | "session_command_attempted"
  | "session_command_finished"
  | "model_connection_attempted"
  | "model_connection_finished"
  | "model_connection_resolved";

type AnalyticsConfig = ClientConfig["analytics"];
export type AnalyticsProperty = boolean | number | string;
export type AnalyticsProperties = Record<string, AnalyticsProperty>;
export type AnalyticsIdentity = Readonly<{
  userId: string;
  accountId: string | null;
}>;
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
let ga4Active = false;
let reoActive = false;
let latestPathname: string | null = null;
let latestSearch = "";
let identityGeneration = 0;
let activeIdentity: AnalyticsIdentity | null = null;
let identifiedUserId: string | null = null;
let identifiedAccountId: string | null = null;
let suspended = false;

declare global {
  interface Window {
    Reo?: ReoClient;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function syncAnalytics(config: AnalyticsConfig, pathname: string, search = ""): void {
  suspended = false;
  activeConfig = config;
  latestPathname = pathname;
  latestSearch = search;
  // Reo observes the ambient URL itself. Keep it off query-bearing routes;
  // PostHog and GA4 below receive only our explicit content-free projection.
  if (search) {
    try {
      window.Reo?.unload?.();
    } catch {
      /* Optional provider cleanup. */
    }
    reoActive = false;
    ga4Active = false;
    window.gtag?.("consent", "update", { analytics_storage: "denied" });
  }
  if (!analyticsCollectionAllowed()) {
    return;
  }
  if (initialization) {
    if (providersReady) {
      if (!search) {
        if (config.providers.reo && !reoActive)
          void initializeReo(config.providers.reo.clientId).catch(() => {});
        if (config.providers.ga4 && !ga4Active)
          void initializeGa4(config.providers.ga4.measurementId).catch(() => {});
      }
      applyActiveIdentity();
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
    void initializeProviders(activeConfig).catch(() => {});
    return;
  }
  if (consent === "denied") {
    clearLoginAnalytics();
    resetProviderIdentity(true);
    stopProviders();
  }
}

/**
 * Associates consented analytics with stable internal IDs only. Names, email
 * addresses, prompts, repository content, and other customer data stay out of
 * the analytics boundary. Calling this is harmless when analytics is disabled.
 */
export function syncAnalyticsIdentity(identity: AnalyticsIdentity | null): void {
  if (
    activeIdentity?.userId !== identity?.userId ||
    activeIdentity?.accountId !== identity?.accountId
  )
    identityGeneration += 1;
  activeIdentity = identity;
  if (!identity) {
    resetProviderIdentity();
    return;
  }
  runWhenProvidersReady(applyActiveIdentity);
}

export function captureAnalyticsEvent(
  name: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): boolean {
  if (!analyticsCollectionAllowed()) return false;
  const acceptedIdentity = identityGeneration;
  const acceptedGeneration = initializationGeneration;
  const context = latestPathname ? journeyPage(latestPathname, latestSearch) : {};
  const send = () => {
    if (acceptedIdentity !== identityGeneration || acceptedGeneration !== initializationGeneration)
      return;
    const facts = { ...context, ...properties };
    posthogClient?.capture(name, facts);
    if (ga4Active && !latestSearch)
      window.gtag?.("event", name, {
        ...facts,
        page_location: window.location.origin,
        page_referrer: "",
        page_title: "OpenGeni",
      });
  };
  if (providersReady && analyticsCollectionAllowed()) {
    try {
      send();
    } catch {
      /* Optional telemetry cannot fail product work. */
    }
  } else runWhenProvidersReady(send);
  return true;
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
      applyActiveIdentity();
      dispatchPageView(latestPathname);
      window.dispatchEvent?.(new Event(ANALYTICS_COLLECTION_ENABLED_EVENT));
    }
  });
  await initialization;
}

function runWhenProvidersReady(callback: () => void): void {
  if (!analyticsCollectionAllowed() || !activeConfig) {
    return;
  }
  void initializeProviders(activeConfig)
    .then(() => {
      if (analyticsCollectionAllowed()) {
        try {
          callback();
        } catch {
          /* Optional telemetry cannot fail product work. */
        }
      }
    })
    .catch(() => {});
}

function analyticsCollectionAllowed(): boolean {
  if (suspended || !activeConfig || !analyticsHasProviders(activeConfig)) {
    return false;
  }
  const consent = storedAnalyticsConsent();
  return consent === "granted" || (!activeConfig.consentRequired && consent !== "denied");
}

function dispatchPageView(pathname: string): void {
  const facts = journeyPage(pathname, latestSearch);
  posthogClient?.capture("$pageview", {
    $current_url: `${window.location.origin}${pathname}`,
    ...facts,
  });
  if (ga4MeasurementId && ga4Active && !latestSearch) {
    window.gtag?.("event", "page_view", {
      page_location: `${window.location.origin}${pathname}`,
      page_referrer: "",
      page_title: "OpenGeni",
      send_to: ga4MeasurementId,
    });
  }
}

async function initializeReo(clientId: string): Promise<void> {
  if (!analyticsCollectionAllowed() || latestSearch) {
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
  if (!analyticsCollectionAllowed() || latestSearch || !window.Reo) {
    return;
  }
  reoActive = true;
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
    // PostHog can derive GeoIP properties before its project-level IP discard runs.
    // Disable that enrichment at the event boundary as well.
    before_send: (event) =>
      event
        ? {
            ...event,
            properties: safePosthogProperties(event.properties),
          }
        : null,
    save_campaign_params: false,
    save_referrer: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
  });
  posthogClient = posthog;
}

function applyActiveIdentity(): void {
  if (!activeIdentity || !posthogClient || !analyticsCollectionAllowed()) {
    return;
  }
  const opened = identifiedUserId !== activeIdentity.userId;
  if (opened) {
    if (identifiedUserId) {
      posthogClient.reset();
    }
    posthogClient.identify(activeIdentity.userId);
    identifiedUserId = activeIdentity.userId;
    identifiedAccountId = null;
  }
  if (activeIdentity.accountId && identifiedAccountId !== activeIdentity.accountId) {
    posthogClient.group("account", activeIdentity.accountId);
    identifiedAccountId = activeIdentity.accountId;
  } else if (!activeIdentity.accountId && identifiedAccountId) {
    posthogClient.resetGroups();
    identifiedAccountId = null;
  }
  if (opened) captureAnalyticsEvent("app_opened");
  const login = takeSuccessfulLogin(activeIdentity.userId);
  if (login)
    captureAnalyticsEvent("login_completed", { method: login.method, $insert_id: login.eventId });
}

/** A third-party sink projection only; never modifies application data. */
function safePosthogProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...properties, $geoip_disable: true };
  for (const key of Object.keys(safe)) {
    // SDK-generated person properties can also contain initial URLs/campaigns.
    if (key === "$set" || key === "$set_once") {
      if (safe[key] && typeof safe[key] === "object" && !Array.isArray(safe[key])) {
        safe[key] = safePosthogProperties(safe[key] as Record<string, unknown>);
      }
    } else if (/url|referrer|pathname|title|utm_|gclid|fbclid|msclkid/i.test(key)) {
      delete safe[key];
    }
  }
  // Product navigation is represented by page/section/UUID properties, never
  // by the ambient URL, page title, referral, or campaign query values.
  return safe;
}

/** Request telemetry is observational: no request/response content or auth material. */
export function beginAnalyticsRequest(
  pathname: string,
  method: string,
): (status: number | null) => void {
  try {
    const operation = journeyOperation(pathname, method);
    if (!operation || !analyticsCollectionAllowed()) return () => {};
    const generation = identityGeneration;
    const consentGeneration = initializationGeneration;
    const start = performance.now();
    const properties = { ...operation.properties, interaction_id: crypto.randomUUID() };
    captureAnalyticsEvent(`${operation.operation}_attempted`, properties);
    let finished = false;
    return (status) => {
      if (finished) return;
      finished = true;
      if (generation !== identityGeneration || consentGeneration !== initializationGeneration)
        return;
      captureAnalyticsEvent(`${operation.operation}_finished`, {
        ...properties,
        outcome: status === null ? "outcome_unknown" : journeyOutcome(status),
        ...(status !== null ? { http_status: status } : {}),
        duration_ms: Math.round(performance.now() - start),
      });
    };
  } catch {
    return () => {};
  }
}

/** Bind asynchronous provider results to the initiating identity and consent. */
export function trackModelConnection(
  provider: "codex" | "supergrok" | "ai-gateway" | "openrouter",
  workspaceId: string,
): (outcome: "connected" | "expired" | "denied" | "outcome_unknown") => void {
  const generation = identityGeneration;
  const consentGeneration = initializationGeneration;
  const allowed = analyticsCollectionAllowed();
  let finished = false;
  return (outcome) => {
    if (
      !allowed ||
      finished ||
      generation !== identityGeneration ||
      consentGeneration !== initializationGeneration
    )
      return;
    finished = true;
    captureAnalyticsEvent("model_connection_resolved", {
      provider,
      workspace_id: workspaceId,
      outcome,
    });
  };
}

function resetProviderIdentity(force = false): void {
  if (force || identifiedUserId) {
    posthogClient?.reset();
  }
  identifiedUserId = null;
  identifiedAccountId = null;
}

async function initializeGa4(measurementId: string): Promise<void> {
  if (!analyticsCollectionAllowed() || latestSearch) {
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
  ga4Active = true;
  if (document.getElementById(GA4_SCRIPT_ID)) {
    return;
  }
  window.gtag("js", new Date());
  window.gtag("config", measurementId, {
    allow_google_signals: false,
    page_location: window.location.origin,
    page_referrer: "",
    page_title: "OpenGeni",
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
  ga4Active = false;
  reoActive = false;
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

installAnalyticsObserver({
  capture: (name, properties) => providersReady && captureAnalyticsEvent(name, properties),
  request: (pathname, method) =>
    providersReady ? beginAnalyticsRequest(pathname, method) : () => {},
  connection: (provider, workspaceId) =>
    providersReady ? trackModelConnection(provider, workspaceId) : () => {},
});
