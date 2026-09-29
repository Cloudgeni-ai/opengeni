import type { AnalyticsConsentDecision } from "@opengeni/contracts/analytics-consent-report";
import type { ClientConfig } from "@/types";

export type AnalyticsConsent = "granted" | "denied";

type AnalyticsConfig = ClientConfig["analytics"];

export const ANALYTICS_COLLECTION_ENABLED_EVENT = "opengeni:analytics-collection-enabled";

const CONSENT_STORAGE_KEY = "opengeni.analyticsConsent";

/** Dispatched when Account menu asks to reopen the consent sheet. */
export const OPEN_ANALYTICS_PREFERENCES_EVENT = "opengeni:open-analytics-preferences";

let inMemoryConsent: AnalyticsConsent | null = null;
/** Survives a click before the lazy AnalyticsManager mounts and attaches its listener. */
let pendingOpenPreferences = false;

export function analyticsHasProviders(config: AnalyticsConfig | null | undefined): boolean {
  return Boolean(config && Object.values(config.providers).some(Boolean));
}

/** True when the console should offer analytics consent UI (first visit + Account reopen). */
export function analyticsPreferencesAvailable(config: AnalyticsConfig | null | undefined): boolean {
  return Boolean(config?.consentRequired && analyticsHasProviders(config));
}

export function openAnalyticsPreferences(): void {
  pendingOpenPreferences = true;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_ANALYTICS_PREFERENCES_EVENT));
}

/** Consume a pending Account-menu open (e.g. event fired before the manager mounted). */
export function takePendingAnalyticsPreferencesOpen(): boolean {
  if (!pendingOpenPreferences) return false;
  pendingOpenPreferences = false;
  return true;
}

export function storedAnalyticsConsent(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): AnalyticsConsent | null {
  if (!storage) {
    return inMemoryConsent;
  }
  try {
    const value = storage.getItem(CONSENT_STORAGE_KEY);
    if (value === null) {
      return inMemoryConsent;
    }
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return inMemoryConsent;
  }
}

export function persistAnalyticsConsent(
  consent: AnalyticsConsent,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  inMemoryConsent = consent;
  try {
    storage?.setItem(CONSENT_STORAGE_KEY, consent);
  } catch {
    // Embedded/private browsing contexts may deny storage. The in-memory choice
    // still governs this page; the banner will be shown again on a future visit.
  }
}

let consentDecisionSender: ((body: string) => void) | null = null;

/** Install the beacon transport once at boot; tests and non-browser hosts leave it unset. */
export function setAnalyticsConsentDecisionSender(send: ((body: string) => void) | null): void {
  consentDecisionSender = send;
}

/**
 * Count a banner answer on the server (`opengeni_analytics_consent_total`).
 * The body is only the closed decision: no identifier, URL, or cookie. This is
 * a first-party operational count, not provider analytics, so it is sent for
 * `denied` too and never starts a provider.
 */
export function reportAnalyticsConsentDecision(decision: AnalyticsConsentDecision): void {
  try {
    consentDecisionSender?.(JSON.stringify({ decision }));
  } catch {
    // Optional operational telemetry cannot affect the consent choice.
  }
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
