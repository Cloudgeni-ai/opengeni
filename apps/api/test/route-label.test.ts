import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import { createApp, routeLabel } from "../src/app";
import {
  boundedRegisteredRouteLabel,
  registeredHandlerRoutePath,
} from "../src/http/registered-route-label";

const ID = "5f0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";

function labelledApp() {
  const settings = testSettings({ authRequired: true, accessKey: "route-label-test-key" });
  const observability = createObservability(settings, { component: "api" });
  // Request logs are not under test; keep the whole-table sweep quiet.
  observability.info = () => undefined;
  observability.warn = () => undefined;
  observability.error = () => undefined;
  const labels: string[] = [];
  const record = observability.recordHttpRequest.bind(observability);
  observability.recordHttpRequest = (input) => {
    labels.push(input.route);
    record(input);
  };
  const app = createApp({
    settings,
    observability,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  return { app, labels };
}

async function labelFor(
  subject: ReturnType<typeof labelledApp>,
  method: string,
  path: string,
): Promise<string> {
  const before = subject.labels.length;
  await subject.app.request(path, { method }).catch(() => undefined);
  expect(subject.labels.length).toBe(before + 1);
  return subject.labels.at(-1)!;
}

describe("HTTP route labels", () => {
  test("labels previously unknown product routes with their registered template", async () => {
    const subject = labelledApp();
    const cases: Array<[string, string, string]> = [
      ["POST", "/v1/auth/organization-onboarding", "/v1/auth/organization-onboarding"],
      ["GET", "/v1/auth/organization-onboarding", "/v1/auth/organization-onboarding"],
      ["POST", "/v1/auth/organization-setup", "/v1/auth/organization-setup"],
      ["GET", "/v1/auth/get-session", "/v1/auth/get-session"],
      ["GET", "/v1/access/me", "/v1/access/me"],
      ["GET", "/v1/billing/usage-summary", "/v1/billing/usage-summary"],
      ["GET", "/v1/billing/usage-workspaces", "/v1/billing/usage-workspaces"],
      ["GET", "/v1/workspaces", "/v1/workspaces"],
      ["GET", `/v1/organizations/${ID}/members`, "/v1/organizations/:organizationId/members"],
      [
        "GET",
        `/v1/workspaces/${ID}/rigs/${ID}/versions`,
        "/v1/workspaces/:workspaceId/rigs/:rigId/versions",
      ],
      [
        "PUT",
        `/v1/workspaces/${ID}/sessions/${ID}/archive`,
        "/v1/workspaces/:workspaceId/sessions/:sessionId/archive",
      ],
      [
        "POST",
        `/v1/workspaces/${ID}/knowledge/entries/search`,
        "/v1/workspaces/:workspaceId/knowledge/entries/search",
      ],
      // Hono dispatches this GET to the parameterized entry read, and the
      // label follows the handler that actually answers.
      [
        "GET",
        `/v1/workspaces/${ID}/knowledge/entries/search`,
        "/v1/workspaces/:workspaceId/knowledge/entries/:entryId",
      ],
    ];
    for (const [method, path, expected] of cases) {
      expect(await labelFor(subject, method, path)).toBe(expected);
    }
  });

  test("keeps established explicit labels and unregistered paths unchanged", async () => {
    const subject = labelledApp();
    expect(await labelFor(subject, "GET", `/v1/workspaces/${ID}/sessions/${ID}`)).toBe(
      "/v1/workspaces/:workspaceId/sessions/:id",
    );
    expect(await labelFor(subject, "POST", "/v1/billing/checkout")).toBe("/v1/billing/checkout");
    expect(await labelFor(subject, "GET", `/v1/unregistered/${ID}`)).toBe("/v1/unknown");
    expect(await labelFor(subject, "GET", `/not-a-route/${ID}`)).toBe("/unknown");
  });

  test("every registered terminal handler resolves to a bounded, request-free label", async () => {
    const subject = labelledApp();
    const unlabeled: string[] = [];
    const seen = new Set<string>();
    for (const route of subject.app.routes) {
      if (route.handler.length >= 2 || route.path === "/*" || route.path === "*") continue;
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const method = route.method === "ALL" ? "GET" : route.method;
      const sample = route.path.replace(/:[A-Za-z0-9_]+(\{[^/]*\})?/g, ID).replace(/\*$/, "x");
      const label = await labelFor(subject, method, sample);
      if (label === "/v1/unknown" || label === "/unknown") unlabeled.push(key);
      expect(label).not.toContain(ID);
    }
    expect(seen.size).toBeGreaterThan(300);
    expect(unlabeled).toEqual([]);
  }, 60_000);

  test("Better Auth provider endpoints behind one wildcard stay distinguishable", () => {
    for (const endpoint of [
      "sign-up/email",
      "sign-in/email",
      "sign-in/social",
      "sign-out",
      "send-verification-email",
      "verify-email",
      "request-password-reset",
      "reset-password",
      "error",
      "ok",
    ]) {
      expect(routeLabel(`/v1/auth/${endpoint}`, "/v1/auth/*")).toBe(`/v1/auth/${endpoint}`);
    }
    expect(routeLabel("/v1/auth/reset-password/secret-reset-token", "/v1/auth/*")).toBe(
      "/v1/auth/reset-password/:token",
    );
    expect(routeLabel("/v1/auth/callback/google")).toBe("/v1/auth/callback/google");
    expect(routeLabel("/v1/auth/callback/github")).toBe("/v1/auth/callback/github");
    expect(routeLabel("/v1/auth/callback/attacker-chosen")).toBe("/v1/auth/callback/:providerId");
    expect(routeLabel("/v1/auth/list-accounts", "/v1/auth/*")).toBe("/v1/auth/*");
  });

  test("registered path resolution skips middleware and constraint syntax", async () => {
    const app = new Hono();
    const seen: Array<string | null> = [];
    app.use("*", async (c, next) => {
      seen.push(registeredHandlerRoutePath(c));
      await next();
    });
    app.use("/items/*", async (_c, next) => await next());
    app.get("/items/:itemId{[0-9]+}", (c) => c.text("ok"));
    app.get("/items/:itemId/children", (c) => c.text("ok"));
    await app.request("/items/42");
    await app.request("/items/42/children");
    await app.request("/missing");
    expect(seen).toEqual(["/items/:itemId", "/items/:itemId/children", null]);
    expect(boundedRegisteredRouteLabel("/*")).toBeNull();
    expect(boundedRegisteredRouteLabel(undefined)).toBeNull();
  });
});
