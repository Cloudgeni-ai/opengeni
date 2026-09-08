import { storedAnalyticsConsent } from "./analytics-consent";
import type { AuthSession } from "@/types";

const KEY = "opengeni.analyticsLoginAttempt";
type Method = "email" | "google" | "github";
type Receipt = { userId: string; method: Method; eventId: string };
let pending: Receipt | null = null;

/** A consented redirect marker: no credentials, email, or auth session identifier. */
export function beginSocialLoginAnalytics(method: "google" | "github"): void {
  try {
    if (storedAnalyticsConsent() !== "granted") return;
    window.sessionStorage.setItem(KEY, JSON.stringify({ method, startedAt: Date.now() }));
  } catch {
    /* Optional storage. */
  }
}

export function noteSuccessfulLogin(userId: string, method: Method): void {
  if (storedAnalyticsConsent() !== "granted") return;
  pending = { userId, method, eventId: crypto.randomUUID() };
}

export function observeSocialLoginResult(session: AuthSession | null): void {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw);
    const createdAt = Date.parse(session?.session.createdAt ?? "");
    // An old cookie after failed OAuth must never be counted as a fresh login.
    if (
      session &&
      ["google", "github"].includes(value.method) &&
      typeof value.startedAt === "number" &&
      Date.now() - value.startedAt < 600_000 &&
      value.startedAt <= Date.now() &&
      createdAt >= value.startedAt - 1_000
    ) {
      noteSuccessfulLogin(session.user.id, value.method);
    }
  } catch {
    /* Analytics cannot affect authentication. */
  }
}

export function takeSuccessfulLogin(userId: string): Receipt | null {
  const receipt = pending;
  pending = null;
  return storedAnalyticsConsent() === "granted" && receipt?.userId === userId ? receipt : null;
}

export function clearLoginAnalytics(): void {
  pending = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* Optional storage. */
  }
}
