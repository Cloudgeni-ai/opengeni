import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  interactionActorForGrant,
  validateBrowserRequestOrigin,
} from "../src/routes/browser-sessions";

const routeUrl = new URL("../src/routes/browser-sessions.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

describe("BrowserSession route discipline", () => {
  test("registers the complete lifecycle, semantic control, diagnostics, and frame surface", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/attached-browsers"',
      '"/v1/workspaces/:workspaceId/attached-browsers/:deviceId"',
      '"/v1/workspaces/:workspaceId/browser-sessions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/select"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/report"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/protected-fill"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/operations/:operationId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/diagnostics"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/heartbeat"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/revisions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/suspend"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
    ]) {
      expect(source).toContain(route);
    }
    expect(await readFile(appUrl, "utf8")).toContain(
      "registerBrowserSessionRoutes(app, routeDeps)",
    );
  });

  test("authenticates before parsing and never places frame credentials in URLs", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create.indexOf("requireAccessGrant")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("requireAccessGrant")).toBeLessThan(
      create.indexOf("parseJsonBody(context, CreateBrowserSessionRequest)"),
    );
    expect(source).toContain('kind: "direct_websocket"');
    expect(source).toContain('kind: "relay"');
    expect(source).toContain("BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX");
    expect(source).not.toMatch(/url[^\n]*relayToken/u);
  });

  test("admits every controller call through the durable generation fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    expect(source).toContain("touchBrowserSessionController(deps.db");
    expect(source).toContain("BrowserSession controller authority changed");
    const activeController = source.slice(
      source.indexOf("async function withActiveBrowserController"),
    );
    expect(activeController.indexOf("if (!admitted)")).toBeLessThan(
      activeController.indexOf("return await withBrowserPlacement("),
    );
  });

  test("brokers protected auth outside model-visible browser actions", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/protected-fill"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify"',
      start,
    );
    const route = source.slice(start, end);
    expect(route.indexOf("if (replay?.response)")).toBeLessThan(
      route.indexOf("withActiveBrowserController"),
    );
    expect(route.indexOf("getProtectedAuthFillPreparation")).toBeLessThan(
      route.indexOf("loadBoundBrowserCredential"),
    );
    expect(route.indexOf("dispatchProtectedAuthFill")).toBeLessThan(
      route.indexOf("sessionClient.protectedAuthFill"),
    );
    expect(route).toContain("resolveProtectedAuthFieldValues");
    expect(route).toContain("protectedAuthReceipt");
    expect(route).not.toContain("BrowserActionCommand.parse");
  });

  test("resolves linked browsers through the exact active ComputerSession placement", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create.indexOf("requireLinkedComputerBinding")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("requireLinkedComputerBinding")).toBeLessThan(
      create.indexOf("client.createSession"),
    );
    const binding = source.slice(source.indexOf("async function requireLinkedComputerBinding"));
    expect(binding).toContain("sameInteractionPlacement");
    expect(binding).toContain("record.session.controller.placementInstanceId");
    expect(binding).toContain(
      "controllerGeneration: record.session.controller.controllerGeneration",
    );
  });

  test("publishes encrypted profile state only after durable dispatch", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/revisions"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
      start,
    );
    const route = source.slice(start, end);
    expect(route.indexOf("prepareBrowserRevisionPublication")).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('prepared.kind === "completed"')).toBeLessThan(
      route.indexOf("const objectStorage = deps.objectStorage"),
    );
    expect(route.indexOf("createPutUrl")).toBeLessThan(
      route.indexOf("dispatchBrowserRevisionPublication"),
    );
    expect(route.indexOf("dispatchBrowserRevisionPublication")).toBeLessThan(
      route.indexOf("client.captureState"),
    );
    expect(route.indexOf("client.captureState")).toBeLessThan(
      route.indexOf("commitBrowserRevisionPublication"),
    );
    expect(route).toContain("dataKey.fill(0)");
    expect(route).toContain("rootKey.fill(0)");
  });

  test("suspends only after encrypted capture and resumes only from durable authority", async () => {
    const source = await readFile(routeUrl, "utf8");
    const suspendStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/suspend"',
    );
    const resumeStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
      suspendStart,
    );
    const endStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
      resumeStart,
    );
    const suspend = source.slice(suspendStart, resumeStart);
    const resume = source.slice(resumeStart, endStart);
    expect(suspend).toContain("if (isTerminalOperation(prepared.operation.state))");
    expect(resume).toContain("if (isTerminalOperation(prepared.operation.state))");
    expect(suspend.indexOf("dispatchBrowserSessionOperation")).toBeLessThan(
      suspend.indexOf("client.captureState"),
    );
    expect(suspend).toContain('afterCapture: "stop"');
    expect(suspend.indexOf("client.captureState")).toBeLessThan(
      suspend.indexOf("commitBrowserSessionSuspension"),
    );
    expect(suspend.indexOf("commitBrowserSessionSuspension")).toBeLessThan(
      suspend.indexOf("endCapturedBrowserController"),
    );
    expect(resume.indexOf("getBrowserPrivateCheckpointAuthority")).toBeLessThan(
      resume.indexOf("prepareBrowserPrivateCheckpointRestore"),
    );
    expect(resume.indexOf("prepareBrowserPrivateCheckpointRestore")).toBeLessThan(
      resume.indexOf("ensureDispatchedGeneration"),
    );
    expect(resume.indexOf("ensureDispatchedGeneration")).toBeLessThan(
      resume.indexOf("client.createSession"),
    );
  });

  test("preserves exact human, service, and agent-attempt action provenance", () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "subject",
      permissions: [] as const,
    };
    expect(interactionActorForGrant({ ...grant, principalKind: "human_session" })).toEqual({
      kind: "human",
      subjectId: "subject",
    });
    expect(interactionActorForGrant({ ...grant, principalKind: "service" })).toEqual({
      kind: "system",
      subjectId: "subject",
    });
    expect(
      interactionActorForGrant({
        ...grant,
        principalKind: "agent_attempt",
        metadata: {
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 2,
        },
      }),
    ).toEqual({
      kind: "agent",
      subjectId: "subject",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 2,
    });
  });

  test("distinguishes malformed and disallowed browser origins", () => {
    expect(validateBrowserRequestOrigin(undefined, "https://app\\.opengeni\\.test")).toBeNull();
    expect(
      validateBrowserRequestOrigin("https://app.opengeni.test", "https://app\\.opengeni\\.test"),
    ).toBe("https://app.opengeni.test");
    expect(() =>
      validateBrowserRequestOrigin("https://other.test", "https://app\\.opengeni\\.test"),
    ).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => validateBrowserRequestOrigin("https://app.opengeni.test/path", ".*")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
