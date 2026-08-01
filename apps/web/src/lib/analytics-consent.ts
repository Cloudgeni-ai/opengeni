import type { ClientConfig } from "@/types";

export type AnalyticsConsent = "granted" | "denied";

type AnalyticsConfig = ClientConfig["analytics"];

const CONSENT_STORAGE_KEY = "opengeni.analyticsConsent";

let inMemoryConsent: AnalyticsConsent | null = null;

export function analyticsHasProviders(config: AnalyticsConfig | null | undefined): boolean {
  return Boolean(config && Object.values(config.providers).some(Boolean));
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
