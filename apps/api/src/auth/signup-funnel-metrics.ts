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

/** The only observability surface funnel telemetry uses. */
export type SignupFunnelObservability = Pick<Observability, "incrementCounter">;

/** Better Auth request-body / OAuth-state key that carries first-touch attribution. */
export const SIGNUP_ATTRIBUTION_AUTH_FIELD = "opengeniAttribution";

export type SignupFunnelMetrics = {
  /** A managed auth user was created (Better Auth `user.create.after`). */
  recordSignUp(authContext: unknown): Promise<void>;
  /** A managed user verified their email address. */
  recordEmailVerified(): void;
  /**
   * A provider session was created that is not an internally discarded one.
   * In the legacy session-set mode this includes the session the first
   * successful email-verification click creates: that is the new user's first
   * sign-in, so it is counted rather than folded into `email_verified`.
   */
  recordSignIn(): void;
};

export function authFunnelMethod(providerId: string | null | undefined): AuthFunnelMethod {
  if (providerId === "credential") return "email";
  if (providerId === "google" || providerId === "github") return providerId;
  return "other";
}

/**
 * Publish every closed series at zero so dashboards and alerts can tell a quiet
 * funnel from missing instrumentation. Never throws: a metric-registry failure
 * must not stop managed auth (and with it API startup) from composing.
 */
export function registerSignupFunnelMetricBaselines(
  observability: SignupFunnelObservability,
): void {
  const baseline = (
    metric: { name: string; help: string },
    labels: Record<string, string>,
  ): void => {
    try {
      observability.incrementCounter({ ...metric, labels, amount: 0 });
    } catch {
      // Telemetry only; the series appears on its first real increment.
    }
  };
  for (const event of AUTH_FUNNEL_EVENTS) {
    for (const method of AUTH_FUNNEL_METHODS) baseline(AUTH_EVENTS_METRIC, { event, method });
  }
  for (const outcome of ORGANIZATION_SETUP_OUTCOMES) {
    baseline(ORGANIZATION_SETUP_METRIC, { outcome });
  }
  for (const source of SIGNUP_ACQUISITION_SOURCES) baseline(SIGNUP_ACQUISITION_METRIC, { source });
}

export function createSignupFunnelMetrics(
  observability: SignupFunnelObservability,
): SignupFunnelMetrics {
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
  observability: SignupFunnelObservability | undefined,
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
