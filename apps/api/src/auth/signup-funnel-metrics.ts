import {
  SIGNUP_ACQUISITION_SOURCES,
  signupAcquisitionSource,
  type SignupAcquisitionSource,
} from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";
import { getOAuthState } from "better-auth/api";

import {
  currentManagedAuthProviderId,
  shouldDiscardCurrentManagedAuthProviderSession,
} from "./managed-auth-attempt-context";

/**
 * Content-free sign-up funnel counters. Every label is a closed set: no user,
 * email, organization, workspace, or campaign value ever becomes a label.
 */
export const AUTH_FUNNEL_EVENTS = ["sign_up", "email_verified", "sign_in"] as const;
export type AuthFunnelEvent = (typeof AUTH_FUNNEL_EVENTS)[number];
export const AUTH_FUNNEL_METHODS = ["email", "google", "github", "other"] as const;
export type AuthFunnelMethod = (typeof AUTH_FUNNEL_METHODS)[number];
export const ORGANIZATION_SETUP_OUTCOMES = ["created", "failed"] as const;
export type OrganizationSetupOutcome = (typeof ORGANIZATION_SETUP_OUTCOMES)[number];

const AUTH_EVENTS_METRIC = {
  name: "opengeni_auth_events_total",
  help: "Managed authentication funnel events (sign-up, email verification, sign-in) by closed method.",
} as const;
const ORGANIZATION_SETUP_METRIC = {
  name: "opengeni_organization_setup_total",
  help: "Self-service post-sign-in organization setup outcomes.",
} as const;
const SIGNUP_ACQUISITION_METRIC = {
  name: "opengeni_signup_acquisition_total",
  help: "New managed users by normalized first-touch acquisition source.",
} as const;

/** Better Auth request-body / OAuth-state key that carries first-touch attribution. */
export const SIGNUP_ATTRIBUTION_AUTH_FIELD = "opengeniAttribution";

export type SignupFunnelMetrics = {
  /** A managed auth user was created (Better Auth `user.create.after`). */
  recordSignUp(authContext: unknown): Promise<void>;
  /** A managed user verified their email address. */
  recordEmailVerified(): void;
  /** A provider session was created that is not an internally discarded one. */
  recordSignIn(): void;
};

export function authFunnelMethod(providerId: string | null | undefined): AuthFunnelMethod {
  if (providerId === "credential") return "email";
  if (providerId === "google" || providerId === "github") return providerId;
  return "other";
}

/**
 * Publish every closed series at zero so dashboards and alerts can tell a quiet
 * funnel from missing instrumentation.
 */
export function registerSignupFunnelMetricBaselines(observability: Observability): void {
  for (const event of AUTH_FUNNEL_EVENTS) {
    for (const method of AUTH_FUNNEL_METHODS) {
      observability.incrementCounter({
        ...AUTH_EVENTS_METRIC,
        labels: { event, method },
        amount: 0,
      });
    }
  }
  for (const outcome of ORGANIZATION_SETUP_OUTCOMES) {
    observability.incrementCounter({
      ...ORGANIZATION_SETUP_METRIC,
      labels: { outcome },
      amount: 0,
    });
  }
  for (const source of SIGNUP_ACQUISITION_SOURCES) {
    observability.incrementCounter({ ...SIGNUP_ACQUISITION_METRIC, labels: { source }, amount: 0 });
  }
}

export function createSignupFunnelMetrics(observability: Observability): SignupFunnelMetrics {
  registerSignupFunnelMetricBaselines(observability);
  const authEvent = (event: AuthFunnelEvent, method: AuthFunnelMethod) => {
    observability.incrementCounter({ ...AUTH_EVENTS_METRIC, labels: { event, method } });
  };
  return {
    recordSignUp: async (authContext) => {
      try {
        authEvent("sign_up", authFunnelMethod(currentManagedAuthProviderId()));
        const source: SignupAcquisitionSource = signupAcquisitionSource(
          await signupAttributionFromAuthContext(authContext),
        );
        observability.incrementCounter({ ...SIGNUP_ACQUISITION_METRIC, labels: { source } });
      } catch {
        // Funnel telemetry must never fail account creation.
      }
    },
    recordEmailVerified: () => {
      try {
        authEvent("email_verified", "email");
      } catch {
        /* Telemetry only. */
      }
    },
    recordSignIn: () => {
      try {
        // Session-set mode discards the provider session of a non-callback
        // Better Auth call; the product transaction then creates the real one.
        if (shouldDiscardCurrentManagedAuthProviderSession()) return;
        authEvent("sign_in", authFunnelMethod(currentManagedAuthProviderId()));
      } catch {
        /* Telemetry only. */
      }
    },
  };
}

/** Count one self-service organization setup request outcome. */
export function recordOrganizationSetupOutcome(
  observability: Observability | undefined,
  outcome: OrganizationSetupOutcome,
): void {
  try {
    observability?.incrementCounter({ ...ORGANIZATION_SETUP_METRIC, labels: { outcome } });
  } catch {
    // Telemetry must never change the setup response.
  }
}

/**
 * Read untrusted first-touch attribution from the Better Auth endpoint that is
 * creating the user: the email sign-up body, or the server-side OAuth state
 * (`additionalData`) that the social start stored for its callback.
 */
export async function signupAttributionFromAuthContext(authContext: unknown): Promise<unknown> {
  const body =
    authContext && typeof authContext === "object"
      ? (authContext as { body?: unknown }).body
      : undefined;
  if (body && typeof body === "object" && SIGNUP_ATTRIBUTION_AUTH_FIELD in body) {
    return (body as Record<string, unknown>)[SIGNUP_ATTRIBUTION_AUTH_FIELD];
  }
  try {
    const state: unknown = await getOAuthState();
    if (state && typeof state === "object" && SIGNUP_ATTRIBUTION_AUTH_FIELD in state) {
      return (state as Record<string, unknown>)[SIGNUP_ATTRIBUTION_AUTH_FIELD];
    }
  } catch {
    // Not inside a Better Auth OAuth callback.
  }
  return undefined;
}
