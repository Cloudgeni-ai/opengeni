import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { FileAsset } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { allowedCorsOrigin, validateInteractionRequestOrigin } from "../src/http/cors";
import {
  browserFileAuthoritySubjectId,
  interactionActorForGrant,
  requireAuthorizedBrowserUploadFiles,
} from "../src/routes/browser-sessions";

const routeUrl = new URL("../src/routes/browser-sessions.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

const FILE_ID = "33333333-3333-4333-8333-333333333333";

function readyFile(id = FILE_ID): FileAsset {
  return {
    id,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    status: "ready",
    filename: "drive.txt",
    safeFilename: "drive.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    bucket: "test",
    objectKey: `files/${id}`,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function httpStatus(operation: () => unknown): number | "resolved" {
  try {
    operation();
    return "resolved";
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

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
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId/save"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/clipboard"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/report"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/protected-fill"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive"',
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
    const attachment = source.slice(
      source.indexOf(
        '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments"',
      ),
      source.indexOf('"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/heartbeat"'),
    );
    expect(attachment).toContain("requestOrigin(context, deps.settings)");
    expect(attachment).toContain("client.addAllowedOrigins([origin])");
  });

  test("rejects archived identities before acquiring a browser placement", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create).toContain("await getBrowserIdentity(deps.db");
    expect(create.indexOf("await getBrowserIdentity(deps.db")).toBeLessThan(
      create.indexOf("await withBrowserPlacement("),
    );
    expect(create).toContain('identity.status !== "active"');
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

  test("keeps provider auth durable while gating its hosted flow to humans", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth"',
    );
    const interactiveStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive"',
      start,
    );
    const durable = source.slice(start, interactiveStart);
    const interactive = source.slice(
      interactiveStart,
      source.indexOf(
        '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify"',
        interactiveStart,
      ),
    );
    expect(durable.indexOf("prepareExternalAuth")).toBeLessThan(
      durable.indexOf("dispatchExternalAuth"),
    );
    expect(durable.indexOf("dispatchExternalAuth")).toBeLessThan(
      durable.indexOf("sessionClient.externalAuth"),
    );
    expect(durable.indexOf("sessionClient.externalAuth")).toBeLessThan(
      durable.indexOf("completeExternalAuth"),
    );
    expect(durable).toContain(
      "provider exposed a hosted login URL outside the human-only endpoint",
    );
    expect(interactive).toContain('grant.principalKind !== "human_session"');
    expect(interactive).toContain('action: "interactive"');
    expect(interactive).not.toContain("completeExternalAuth");
  });

  test("stages upload bytes privately before the canonical browser action", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      start,
    );
    const route = source.slice(start, end);
    expect(route).toContain('requireAccessGrant(context, deps, workspaceId, "files:read")');
    expect(route).not.toContain("getFiles(deps.db");
    expect(route).toContain("getFilesForSubject(deps.db");
    expect(route).toContain("browserFileAuthoritySubjectId(grant, sourceAuthorization)");
    expect(route.indexOf("getFilesForSubject(deps.db")).toBeLessThan(
      route.indexOf("requireAuthorizedBrowserUploadFiles"),
    );
    expect(route.indexOf("requireAuthorizedBrowserUploadFiles")).toBeLessThan(
      route.indexOf("createGetUrl"),
    );
    expect(route.indexOf("createGetUrl")).toBeLessThan(
      route.indexOf("sessionClient.stageWorkspaceFiles"),
    );
    expect(route.indexOf("sessionClient.stageWorkspaceFiles")).toBeLessThan(
      route.indexOf("sessionClient.action(command)"),
    );
    expect(route).toContain("sessionClient.receipt(request.operationId)");
  });

  test("binds agent uploads to the frozen initiating human, not the worker subject", () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "worker:first-party-mcp",
      permissions: [] as const,
      principalKind: "agent_attempt" as const,
    };
    const authorization = {
      actor: {
        kind: "agent_attempt" as const,
        subjectId: "worker:first-party-mcp",
        callerSessionId: "44444444-4444-4444-8444-444444444444",
        callerRootSessionId: "44444444-4444-4444-8444-444444444444",
        turnId: "55555555-5555-4555-8555-555555555555",
        attemptId: "66666666-6666-4666-8666-666666666666",
        executionGeneration: 1,
        initiator: { kind: "subject" as const, subjectId: "user:drive-owner" },
        initiatorContext: { source: "user" as const },
        initiatingHumanSubjectId: "user:drive-owner",
      },
      target: {
        sessionId: "44444444-4444-4444-8444-444444444444",
        rootSessionId: "44444444-4444-4444-8444-444444444444",
      },
      relatedSessionAccess: "root" as const,
      reauthorizeAfterMs: null,
    };
    expect(browserFileAuthoritySubjectId(grant, authorization)).toBe("user:drive-owner");
    expect(browserFileAuthoritySubjectId(grant, null)).toBeNull();
  });

  for (const condition of [
    "denied ACL evidence",
    "stale ACL evidence",
    "disconnected Drive authority",
    "revoked Drive scope",
  ]) {
    test(`fails the upload closed before signing when authority is omitted for ${condition}`, () => {
      expect(httpStatus(() => requireAuthorizedBrowserUploadFiles([FILE_ID], []))).toBe(404);
    });
  }

  test("fails a mixed ordinary/Drive upload when any requested file is unauthorized", () => {
    const ordinaryId = "77777777-7777-4777-8777-777777777777";
    expect(
      httpStatus(() =>
        requireAuthorizedBrowserUploadFiles([ordinaryId, FILE_ID], [readyFile(ordinaryId)]),
      ),
    ).toBe(404);
  });

  test("publishes one exact private download before one fenced workspace import", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId/save"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation"',
      start,
    );
    const route = source.slice(start, end);
    expect(route.indexOf("findBrowserDownloadSave")).toBeLessThan(
      route.indexOf("if (!objectStorage)"),
    );
    expect(route.indexOf("sessionClient.exportDownload")).toBeLessThan(
      route.indexOf("finalizeBrowserDownloadFile"),
    );
    expect(route.indexOf("finalizeBrowserDownloadFile")).toBeLessThan(
      route.indexOf("dispatchBrowserDownloadSave"),
    );
    expect(route.indexOf("dispatchBrowserDownloadSave")).toBeLessThan(
      route.indexOf("service.importWorkspaceFile"),
    );
    expect(route.indexOf("service.importWorkspaceFile")).toBeLessThan(
      route.indexOf("completeBrowserDownloadSave"),
    );
    expect(route).toContain('operation: "browser.download.save"');
    expect(route).toContain("mayReplaceExisting: save.overwrite && dispatched.dispatchedNow");
  });

  test("resolves linked browsers through the exact active ComputerSession placement", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create.indexOf("ensureLinkedComputerController")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("ensureLinkedComputerController")).toBeLessThan(
      create.indexOf("client.createSession"),
    );
    const binding = source.slice(source.indexOf("async function ensureLinkedComputerController"));
    expect(binding).toContain("sameInteractionPlacement");
    expect(binding).toContain("record.session.controller.placementInstanceId");
    expect(binding).toContain(
      "controllerGeneration: record.session.controller.controllerGeneration",
    );
    expect(binding.indexOf("await sessionClient.heartbeat()")).toBeLessThan(
      binding.indexOf("await client.createComputerSession"),
    );
    expect(binding).toContain("isMissingLinkedComputerControllerSession(error)");
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
    expect(route.indexOf("dispatchBrowserRevisionPublication")).toBeLessThan(
      route.indexOf("stateUpload"),
    );
    expect(route.indexOf("stateUpload")).toBeLessThan(route.indexOf("createPutUrl"));
    expect(route.indexOf("createPutUrl")).toBeLessThan(route.indexOf("client.captureState"));
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
      suspend.indexOf("stateUpload"),
    );
    expect(suspend.indexOf("stateUpload")).toBeLessThan(suspend.indexOf("createPutUrl"));
    expect(suspend.indexOf("createPutUrl")).toBeLessThan(suspend.indexOf("client.captureState"));
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
      resume.indexOf("resolveBrowserNetworkRouteLaunch"),
    );
    expect(resume.indexOf("resolveBrowserNetworkRouteLaunch")).toBeLessThan(
      resume.indexOf("ensureDispatchedGeneration"),
    );
    expect(resume.indexOf("ensureDispatchedGeneration")).toBeLessThan(
      resume.indexOf("client.createSession"),
    );
    expect(resume).toContain("...(networkRoute ? { networkRoute } : {})");
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

  test("accepts first-party interaction origins without widening credentialed CORS", () => {
    const input = {
      corsAllowOriginRegex: "https://trusted-embed\\.test",
      publicBaseUrl: "https://app.opengeni.test/",
      webBaseUrl: "https://web.opengeni.test",
    };
    expect(validateInteractionRequestOrigin(undefined, input)).toBeNull();
    expect(validateInteractionRequestOrigin("https://app.opengeni.test", input)).toBe(
      "https://app.opengeni.test",
    );
    expect(allowedCorsOrigin(input.corsAllowOriginRegex, "https://app.opengeni.test")).toBe(false);
    expect(validateInteractionRequestOrigin("https://web.opengeni.test", input)).toBe(
      "https://web.opengeni.test",
    );
    expect(validateInteractionRequestOrigin("https://trusted-embed.test", input)).toBe(
      "https://trusted-embed.test",
    );
    expect(() => validateInteractionRequestOrigin("https://other.test", input)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => validateInteractionRequestOrigin("https://app.opengeni.test/path", input)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
