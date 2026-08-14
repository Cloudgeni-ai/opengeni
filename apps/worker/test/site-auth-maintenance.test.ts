import { describe, expect, mock, test } from "bun:test";
import type { SiteAuthMaintenanceClaim } from "@opengeni/db";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { createSiteAuthMaintenanceActivities } from "../src/activities/site-auth-maintenance";
import type { ActivityServices } from "../src/activities/types";

const claim: SiteAuthMaintenanceClaim = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444",
  siteAuthConnectionId: "55555555-5555-4555-8555-555555555555",
  connectionVersion: 2,
  action: "repair",
  dueAt: new Date("2026-08-11T01:00:00.000Z"),
  claimedAt: new Date("2026-08-11T01:01:00.000Z"),
  name: "Production account",
  accountLabel: "operator@example.com",
  loginUrl: "https://example.com/login",
  verificationUrlPrefixes: ["https://example.com/app"],
  preferredIdentityId: "66666666-6666-4666-8666-666666666666",
  preferredPlacement: {
    kind: "sandbox_group",
    sandboxGroupId: "88888888-8888-4888-8888-888888888888",
  },
  preferredNetworkRouteId: "77777777-7777-4777-8777-777777777777",
  healthPolicy: { mode: "maintained", intervalSeconds: 600, automaticRepair: true },
  verificationState: "needs_repair",
};

function services(warn = mock(() => undefined)): () => Promise<ActivityServices> {
  return async () =>
    ({
      settings: testSettings({ sandboxBackend: "none" }),
      db: {} as never,
      bus: new MemoryEventBus(),
      wakeSessionWorkflow: null,
      entitlements: null,
      observability: { info: mock(() => undefined), warn } as never,
    }) as ActivityServices;
}

describe("site auth maintenance", () => {
  test("atomically links one exact visible agent session before initialization", async () => {
    const order: string[] = [];
    const confirm = mock(async () => {
      order.push("confirm");
      return true;
    });
    const recordUsage = mock(async () => undefined);
    let createInput: Record<string, unknown> | null = null;
    const activity = createSiteAuthMaintenanceActivities(services(), {
      claim: async (_db, input) => {
        expect(input).toEqual({ claimTimeoutMs: 123, limit: 1 });
        return [claim];
      },
      claimTimeoutMs: 123,
      batchSize: 1,
      admit: async () => null,
      assertModelPolicy: async () => undefined,
      confirm,
      recordUsage,
      createSession: (async (input) => {
        createInput = input as unknown as Record<string, unknown>;
        order.push("create");
        await input.beforeCreateCommit?.({} as never, claim.sessionId);
        order.push("initialize");
        return {
          session: {
            id: claim.sessionId,
            createdBy: {
              kind: "service",
              subjectId: "site-auth-maintenance",
              label: "OpenGeni authentication maintenance",
            },
            createdByContext: {
              opengeniSiteAuthConnectionId: claim.siteAuthConnectionId,
              opengeniSiteAuthMaintenanceOperationId: claim.operationId,
            },
          },
          outcome: "created",
          replay: false,
          changed: true,
        } as never;
      }) as never,
      defer: async () => {
        throw new Error("successful dispatch must not defer");
      },
    });

    expect(await activity.maintainSiteAuthConnections()).toEqual({
      claimed: 1,
      started: 1,
      deferred: 0,
    });
    expect(order).toEqual(["create", "confirm", "initialize"]);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      siteAuthConnectionId: claim.siteAuthConnectionId,
      operationId: claim.operationId,
      sessionId: claim.sessionId,
    });
    expect(createInput).toMatchObject({
      requestedSessionId: claim.sessionId,
      createIdempotencyKey: `site-auth-maintenance:${claim.operationId}`,
      firstPartyMcpTools: expect.arrayContaining(["browser_open", "browser_auth"]),
    });
    expect(String(createInput?.["initialMessage"])).toContain("Purpose: repair");
    expect(String(createInput?.["initialMessage"])).toContain(claim.preferredNetworkRouteId!);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  test("isolates dispatch failure, releases the exact claim, and redacts details", async () => {
    const warn = mock(() => undefined);
    const defer = mock(async () => true);
    const activity = createSiteAuthMaintenanceActivities(services(warn), {
      claim: async () => [claim],
      admit: async () => null,
      assertModelPolicy: async () => undefined,
      confirm: async () => true,
      recordUsage: async () => undefined,
      createSession: (async () => {
        throw new Error("private provider response and hosted URL");
      }) as never,
      defer,
    });

    expect(await activity.maintainSiteAuthConnections()).toEqual({
      claimed: 1,
      started: 0,
      deferred: 1,
    });
    expect(defer).toHaveBeenCalledWith(expect.anything(), {
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      siteAuthConnectionId: claim.siteAuthConnectionId,
      operationId: claim.operationId,
      sessionId: claim.sessionId,
      retryAt: expect.any(Date),
    });
    const attributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(attributes).toEqual({
      workspaceId: claim.workspaceId,
      siteAuthConnectionId: claim.siteAuthConnectionId,
      action: claim.action,
      errorCategory: "Error",
      claimReleased: true,
    });
    expect(JSON.stringify(attributes)).not.toContain("private provider");
    expect(JSON.stringify(attributes)).not.toContain(claim.loginUrl!);
  });
});
