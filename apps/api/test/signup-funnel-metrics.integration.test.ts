import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("signup-funnel-metrics");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("sign-up funnel metric tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function runtimeSettings() {
  return testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "signup-funnel-metrics-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
  });
}

function captureTransport() {
  const messages: ManagedEmailMessage[] = [];
  const transport: ManagedEmailTransport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:signup-funnel", retentionSeconds: 86_400 },
    send: async (message) => {
      messages.push(message);
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  return { messages, transport };
}

function quietObservability(): Observability {
  const observability = createObservability(runtimeSettings(), { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  observability.error = () => undefined;
  return observability;
}

async function counter(
  observability: Observability,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const text = await observability.prometheusMetrics();
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    if (Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`))) {
      return Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return Number.NaN;
}

function requestHeaders(cookie?: string): Record<string, string> {
  clientAddress += 1;
  return {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": `203.0.113.${clientAddress % 250}`,
    ...(cookie ? { cookie } : {}),
  };
}

function cookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

describe("managed sign-up funnel metrics", () => {
  test("email sign-up, verification, sign-in and organization setup are counted with attribution", async () => {
    if (!shared || !client) return;
    const observability = quietObservability();
    const { messages, transport } = captureTransport();
    const app = createApp({
      settings: runtimeSettings(),
      db: client.db,
      observability,
      managedEmailTransport: transport,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `funnel-${crypto.randomUUID()}@example.test`;
    const password = "funnel-password-123";
    const before = {
      signUp: await counter(observability, "opengeni_auth_events_total", {
        event: "sign_up",
        method: "email",
      }),
      producthunt: await counter(observability, "opengeni_signup_acquisition_total", {
        source: "producthunt",
      }),
    };
    // Every closed series is published before the first event.
    expect(before).toEqual({ signUp: 0, producthunt: 0 });

    const signUp = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        name: "Funnel Human",
        email,
        password,
        callbackURL: "/?auth_event=email_verified&utm_source=producthunt",
        opengeniAttribution: { ref: "producthunt", utmCampaign: "launch-day" },
      }),
    });
    expect(signUp.status).toBeLessThan(300);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_up",
        method: "email",
      }),
    ).toBe(1);
    expect(
      await counter(observability, "opengeni_signup_acquisition_total", { source: "producthunt" }),
    ).toBe(1);
    // An unverified account does not create a session.
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_in",
        method: "email",
      }),
    ).toBe(0);

    // A duplicate sign-up for the same address creates no second user.
    const duplicate = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Funnel Human", email, password }),
    });
    expect(duplicate.status).toBeLessThan(300);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_up",
        method: "email",
      }),
    ).toBe(1);

    const verification = messages.find((message) => message.kind === "email_verification");
    const link = verification?.text.match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeDefined();
    const verificationUrl = new URL(link!);
    expect(verificationUrl.searchParams.get("callbackURL")).toBe(
      "/?auth_event=email_verified&utm_source=producthunt",
    );
    const verified = await app.request(`${verificationUrl.pathname}${verificationUrl.search}`, {
      headers: requestHeaders(),
    });
    expect(verified.status).toBeLessThan(400);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "email_verified",
        method: "email",
      }),
    ).toBe(1);

    const signIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_in",
        method: "email",
      }),
    ).toBe(1);

    const session = cookiePairs(signIn);
    const setup = await app.request("/v1/auth/organization-onboarding", {
      method: "POST",
      headers: requestHeaders(session),
      body: JSON.stringify({ organizationName: "Funnel Org", operationId: crypto.randomUUID() }),
    });
    expect(setup.status).toBe(200);
    expect(
      await counter(observability, "opengeni_organization_setup_total", { outcome: "created" }),
    ).toBe(1);
    const invalid = await app.request("/v1/auth/organization-onboarding", {
      method: "POST",
      headers: requestHeaders(session),
      body: JSON.stringify({ organizationName: "", operationId: "not-a-uuid" }),
    });
    expect(invalid.status).toBe(422);
    expect(
      await counter(observability, "opengeni_organization_setup_total", { outcome: "failed" }),
    ).toBe(1);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).not.toContain(email);
    expect(metrics).not.toContain("launch-day");
  }, 120_000);

  test("social sign-up reads attribution from server-side OAuth state", async () => {
    if (!shared || !client) return;
    const observability = quietObservability();
    const settings = runtimeSettings();
    const { transport } = captureTransport();
    const auth = createManagedAuth(settings, client.db, transport, { observability })!;
    const app = createApp({
      settings,
      db: client.db,
      observability,
      managedAuth: auth,
      managedEmailTransport: transport,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const context = await auth.$context;
    const google = context.socialProviders.find((provider) => provider.id === "google")!;
    google.validateAuthorizationCode = async () => ({
      accessToken: "test-provider-token",
      tokenType: "Bearer",
    });

    async function socialSignUp(additionalData?: Record<string, unknown>) {
      const accountId = crypto.randomUUID();
      google.getUserInfo = async () => ({
        user: {
          id: accountId,
          name: "Provider Human",
          email: `social-${accountId}@example.test`,
          emailVerified: true,
        },
        data: {},
      });
      const start = await app.request("/v1/auth/sign-in/social", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          provider: "google",
          callbackURL: "http://opengeni.test/",
          disableRedirect: true,
          ...(additionalData ? { additionalData } : {}),
        }),
      });
      expect(start.status).toBe(200);
      const authorization = new URL(((await start.json()) as { url: string }).url);
      const callback = await app.request(
        `/v1/auth/callback/google?state=${authorization.searchParams.get("state")}&code=simulated-provider-code`,
        { headers: { ...requestHeaders(cookiePairs(start)) } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("http://opengeni.test/");
    }

    await socialSignUp({
      opengeniAttribution: {
        utmSource: "opengeni.ai",
        utmMedium: "website",
        utmCampaign: "hero-cta",
      },
    });
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_up",
        method: "google",
      }),
    ).toBe(1);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_in",
        method: "google",
      }),
    ).toBe(1);
    expect(
      await counter(observability, "opengeni_signup_acquisition_total", { source: "website" }),
    ).toBe(1);

    await socialSignUp();
    expect(
      await counter(observability, "opengeni_signup_acquisition_total", { source: "direct" }),
    ).toBe(1);
    await socialSignUp({ opengeniAttribution: { utmSource: "<script>" } });
    expect(
      await counter(observability, "opengeni_signup_acquisition_total", { source: "other" }),
    ).toBe(1);
    expect(
      await counter(observability, "opengeni_auth_events_total", {
        event: "sign_up",
        method: "google",
      }),
    ).toBe(3);
  }, 120_000);
});
