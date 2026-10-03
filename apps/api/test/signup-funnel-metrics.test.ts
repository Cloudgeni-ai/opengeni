import { describe, expect, test } from "bun:test";
import { createObservability, type Observability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import {
  runManagedAuthAttempt,
  runManagedAuthDiscardedProviderSession,
  runManagedAuthProvider,
} from "../src/auth/managed-auth-attempt-context";
import {
  authFunnelMethod,
  createSignupFunnelMetrics,
  recordOrganizationSetupOutcome,
  signupAttributionFromAuthContext,
} from "../src/auth/signup-funnel-metrics";
import { createManagedAuth } from "../src/auth/managed-auth";

function metrics(): Observability {
  return createObservability(testSettings(), { component: "api" });
}

async function series(observability: Observability, name: string): Promise<string[]> {
  return (await observability.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`))
    .map((line) =>
      line
        .replace(/(service|environment|component|deployment_revision)="[^"]*",?/g, "")
        .replace(",}", "}"),
    )
    .sort();
}

describe("sign-up funnel metrics", () => {
  test("maps Better Auth providers to a closed method set", () => {
    expect(authFunnelMethod("credential")).toBe("email");
    expect(authFunnelMethod("google")).toBe("google");
    expect(authFunnelMethod("github")).toBe("github");
    expect(authFunnelMethod("saml-acme")).toBe("other");
    expect(authFunnelMethod(undefined)).toBe("other");
  });

  test("publishes every closed series at zero before the first event", async () => {
    const observability = metrics();
    createSignupFunnelMetrics(observability);
    expect(await series(observability, "opengeni_auth_events_total")).toHaveLength(12);
    expect(await series(observability, "opengeni_signup_acquisition_total")).toEqual([
      'opengeni_signup_acquisition_total{source="direct"} 0',
      'opengeni_signup_acquisition_total{source="other"} 0',
      'opengeni_signup_acquisition_total{source="producthunt"} 0',
      'opengeni_signup_acquisition_total{source="website"} 0',
    ]);
    expect(await series(observability, "opengeni_organization_setup_total")).toEqual([
      'opengeni_organization_setup_total{outcome="created"} 0',
      'opengeni_organization_setup_total{outcome="failed"} 0',
    ]);
  });

  test("attributes sign-up and sign-in to the active provider context", async () => {
    const observability = metrics();
    const funnel = createSignupFunnelMetrics(observability);
    await funnel.recordSignUp({ body: { opengeniAttribution: { ref: "producthunt" } } });
    await runManagedAuthProvider("github", async () => {
      await funnel.recordSignUp(null);
      funnel.recordSignIn();
    });
    await runManagedAuthAttempt(crypto.randomUUID(), "google", async () => funnel.recordSignIn());
    // A discarded provider session is replaced by the product-owned session.
    await runManagedAuthDiscardedProviderSession(async () => funnel.recordSignIn());
    funnel.recordEmailVerified();
    const events = await series(observability, "opengeni_auth_events_total");
    expect(events).toContain('opengeni_auth_events_total{event="sign_up",method="email"} 1');
    expect(events).toContain('opengeni_auth_events_total{event="sign_up",method="github"} 1');
    expect(events).toContain('opengeni_auth_events_total{event="sign_in",method="github"} 1');
    expect(events).toContain('opengeni_auth_events_total{event="sign_in",method="google"} 1');
    expect(events).toContain('opengeni_auth_events_total{event="sign_in",method="email"} 0');
    expect(events).toContain('opengeni_auth_events_total{event="email_verified",method="email"} 1');
    expect(await series(observability, "opengeni_signup_acquisition_total")).toEqual([
      'opengeni_signup_acquisition_total{source="direct"} 1',
      'opengeni_signup_acquisition_total{source="other"} 0',
      'opengeni_signup_acquisition_total{source="producthunt"} 1',
      'opengeni_signup_acquisition_total{source="website"} 0',
    ]);
  });

  test("reads attribution only from the auth body or OAuth state and never throws", async () => {
    expect(
      await signupAttributionFromAuthContext({ body: { opengeniAttribution: { ref: "x" } } }),
    ).toEqual({ ref: "x" });
    expect(await signupAttributionFromAuthContext({ body: { name: "Human" } })).toBeUndefined();
    expect(await signupAttributionFromAuthContext(null)).toBeUndefined();
    const failing = {
      incrementCounter: () => {
        throw new Error("registry unavailable");
      },
    } as unknown as Observability;
    expect(() => recordOrganizationSetupOutcome(failing, "created")).not.toThrow();
    expect(() => recordOrganizationSetupOutcome(undefined, "failed")).not.toThrow();
  });

  test("a broken or partial metric registry never fails composition or recording", async () => {
    const throwing = {
      incrementCounter: () => {
        throw new Error("registry unavailable");
      },
    } as unknown as Observability;
    // A partial stub (no incrementCounter at all), as some route tests supply.
    const partial = {} as unknown as Observability;
    for (const observability of [throwing, partial]) {
      let funnel: ReturnType<typeof createSignupFunnelMetrics> | undefined;
      expect(() => {
        funnel = createSignupFunnelMetrics(observability);
      }).not.toThrow();
      await funnel!.recordSignUp({ body: { opengeniAttribution: { ref: "producthunt" } } });
      expect(() => funnel!.recordSignIn()).not.toThrow();
      expect(() => funnel!.recordEmailVerified()).not.toThrow();
    }
  });

  test("managed app composition survives an observability stub without counters", () => {
    const partial = { ...metrics(), incrementCounter: undefined } as unknown as Observability;
    expect(() =>
      createManagedAuth(
        { ...testSettings(), productAccessMode: "managed", betterAuthSecret: "x".repeat(32) },
        {} as never,
        { send: async () => undefined } as never,
        { observability: partial },
      ),
    ).not.toThrow();
  });
});
