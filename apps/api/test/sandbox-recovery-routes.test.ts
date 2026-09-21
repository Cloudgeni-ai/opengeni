import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import type { SandboxRecoveryRequest } from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";

// Exercise the actual HTTP adapter with a deterministic revocation immediately
// after the durable application seam returns, at each separately authorized read.
const realCore = await import("@opengeni/core");
const realDb = await import("@opengeni/db");
const fakeDb = {};
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const request: SandboxRecoveryRequest = {
  operationId: crypto.randomUUID(),
  acceptHistoricalCheckpoint: true,
  selection: {
    version: 1,
    sessionId,
    sandboxGroupId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    routeEpoch: 1,
    authorityEpoch: 1,
    leaseEpoch: 1,
    workspaceGeneration: 10,
    archiveGeneration: 5,
    artifactId: crypto.randomUUID(),
    revision: "private-checkpoint-revision",
    capturedAt: "2026-09-20T08:00:00.000Z",
  },
};
const projection = {
  version: 1 as const,
  status: "restoring" as const,
  reason: null,
  checkpoint: request.selection,
  operationId: request.operationId,
};
let commits = 0;
let reads = 0;
let failRead = 0;
let rejectConsent = false;
mock.module("@opengeni/core", () => ({
  ...realCore,
  requireAccessGrant: async () => ({ accountId: "account", subjectId: "subject" }),
  requireSessionAuthorization: async () => null,
  requireAccessGrantAuthorization: async () => ({
    grant: { accountId: "account", subjectId: "subject" },
  }),
  consentManagedHumanSandboxRecovery: async () => {
    if (rejectConsent) throw new realDb.SandboxRecoveryConflictError("stale consent");
    commits++;
    return { outcome: "accepted", operationId: request.operationId, recovery: projection };
  },
  getManagedHumanSandboxRecovery: async () => {
    reads++;
    if (reads === failRead) throw new realCore.SessionAuthorizationDeniedError("revoked");
    return projection;
  },
}));
const { registerSessionRoutes } = await import("../src/routes/sessions");
afterAll(() => mock.restore());
beforeEach(() => {
  commits = 0;
  reads = 0;
  failRead = 0;
  rejectConsent = false;
});
function app() {
  const instance = new Hono();
  registerSessionRoutes(instance, {
    settings: testSettings(),
    db: fakeDb,
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps);
  return instance;
}
function post() {
  return app().request(
    `http://x/v1/workspaces/${workspaceId}/sessions/${sessionId}/sandbox-recovery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
}
test.each([1, 2])(
  "authorization loss at postaccept observation %s never reports rejected consent or discloses state",
  async (read) => {
    failRead = read;
    const response = await post();
    expect(commits).toBe(1);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      code: "upstream_unavailable",
      message: "Recovery status could not be confirmed. Check status without resubmitting consent.",
      outcomeUnknown: true,
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain(request.operationId);
    expect(JSON.stringify(body)).not.toContain(request.selection.revision);
    expect(JSON.stringify(body)).not.toContain("private revocation");
  },
);
test("preaccept conflict remains a definitive rejection and does not observe or restore", async () => {
  rejectConsent = true;
  const response = await post();
  expect(response.status).toBe(409);
  expect(commits).toBe(0);
  expect(reads).toBe(0);
  expect((await response.json()).code).toBe("SANDBOX_RECOVERY_CONFLICT");
});
test("authorized status stays distinct from consent acceptance", async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: "accepted",
    recovery: { status: "restoring" },
  });
  expect(commits).toBe(1);
  expect(reads).toBe(2);
});
