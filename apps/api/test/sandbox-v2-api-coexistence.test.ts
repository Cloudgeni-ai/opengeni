import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  bootstrapWorkspace,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createSession,
  updateWorkspaceSettings,
} from "@opengeni/db";
import { SessionCapabilities, signDelegatedAccessToken, type Session } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { acquireSharedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import { withChannelA, withChannelARead } from "../src/sandbox/channel-a";
import {
  attachViewer,
  ensureSessionGroupReady,
  mintDesktopStream,
  mintTerminalStream,
} from "../src/sandbox/viewer";
import { sandboxApiUsesNativeMachine } from "../src/sandbox/engine-route";
import { registerSessionRoutes } from "../src/routes/sessions";

test("retained native API access never enters legacy setup after admission changes", async () => {
  const fixture = await acquireSharedTestDatabase("native-api-coexistence");
  if (!fixture) throw Error("Native API coexistence requires disposable PostgreSQL");
  const client = createDb(fixture.appUrl);
  try {
    configureSandboxV2AdmissionPolicy(client.db, {
      enabled: true,
      qualifiedBackends: new Set(["modal"]),
    });
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Synthetic API scope",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Synthetic API scope",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: true });
    const definition = {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "synthetic API access",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "modal" as const,
    };
    const native = await createSession(client.db, definition);
    configureSandboxV2AdmissionPolicy(client.db, { enabled: false, qualifiedBackends: new Set() });
    await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: false });
    const legacy = await createSession(client.db, definition);
    const input = {
      accountId: grant.accountId,
      workspaceId,
      session: native as unknown as Session,
    };
    expect(await sandboxApiUsesNativeMachine(client.db, input)).toBe(true);
    expect(
      await sandboxApiUsesNativeMachine(client.db, {
        ...input,
        session: legacy as unknown as Session,
      }),
    ).toBe(false);
    let establishes = 0;
    let callbacks = 0;
    const services = {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret: "synthetic-native-api-delegation-secret",
        sandboxBackend: "none",
        sandboxV2Enabled: false,
        sandboxOwnershipEnabled: true,
        sandboxDesktopEnabled: true,
        sandboxTerminalEnabled: true,
      }),
      bus: new MemoryEventBus(),
      establishSandboxSession: async () => {
        establishes++;
        throw Error("Synthetic legacy establishment must not run");
      },
    };
    const app = new Hono();
    registerSessionRoutes(app, {
      ...services,
      workflowClient: {} as never,
      objectStorage: null,
      githubStateSecret: "synthetic-native-api-state-secret",
      documentIndexer: { indexDocument: async () => {} },
      getDocumentServices: () => ({}) as never,
    } as unknown as ApiRouteDeps & Pick<typeof services, "establishSandboxSession">);
    const capabilityResponse = async (
      sessionId: string,
      permissions: ["sessions:read"] | ["files:read"],
    ) => {
      const token = await signDelegatedAccessToken(services.settings.delegationSecret!, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        permissions,
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      return app.request(
        `https://example.test/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
    };
    const nativeResponse = await capabilityResponse(native.id, ["sessions:read"]);
    expect(nativeResponse.status).toBe(200);
    const nativeCapabilities = SessionCapabilities.parse(await nativeResponse.json());
    expect(nativeCapabilities.FileSystem).toMatchObject({
      available: false,
      readOnly: true,
      reason: "backend_unsupported",
    });
    expect(nativeCapabilities.Git).toEqual({
      available: false,
      repos: [],
      reason: "backend_unsupported",
    });
    expect(nativeCapabilities.Terminal).toMatchObject({
      transport: "sse-events",
      ptyCapable: false,
      token: null,
      url: null,
      reason: "backend_unsupported",
    });
    expect(nativeCapabilities.DesktopStream).toMatchObject({
      transport: null,
      token: null,
      url: null,
      acknowledged: false,
      shared: false,
      sharedSessionIds: [],
      reason: "backend_unsupported",
    });
    expect(nativeCapabilities.Recording.available).toBe(false);
    expect(nativeCapabilities.archiveComplete).toBe(false);
    expect(nativeCapabilities.archiveGeneration).toBeNull();
    const legacyResponse = await capabilityResponse(legacy.id, ["sessions:read"]);
    expect(legacyResponse.status).toBe(200);
    const legacyCapabilities = SessionCapabilities.parse(await legacyResponse.json());
    expect(legacyCapabilities.FileSystem.available).toBe(true);
    expect(legacyCapabilities.Git.available).toBe(true);
    expect(legacyCapabilities.DesktopStream.reason).toBe("lease_cold");
    expect((await capabilityResponse(native.id, ["files:read"])).status).toBe(403);
    for (const operation of [
      () => attachViewer(services, { ...input, viewerSubjectId: grant.subjectId }),
      () => ensureSessionGroupReady(services, { ...input, subjectId: grant.subjectId }),
      () =>
        withChannelA(services, { ...input, subjectId: grant.subjectId }, async () => {
          callbacks++;
        }),
      () =>
        withChannelARead(services, { ...input, subjectId: grant.subjectId }, async () => {
          callbacks++;
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 409,
        code: "conflict",
        retryable: false,
        outcomeUnknown: false,
        details: { code: "SANDBOX_V2_INTERACTIVE_UNAVAILABLE" },
      });
    }
    const stream = { ...input, viewerId: crypto.randomUUID(), resourceSubjectId: grant.subjectId };
    expect(await mintDesktopStream(services, stream)).toBeNull();
    expect(await mintTerminalStream(services, stream)).toBeNull();
    expect(establishes).toBe(0);
    expect(callbacks).toBe(0);
    const [legacyState] = await fixture.admin<{ leases: number; holders: number }[]>`
      select (select count(*)::integer from sandbox_leases where sandbox_group_id=${native.sandboxGroupId}) as leases,
             (select count(*)::integer from sandbox_lease_holders holder
               join sandbox_leases lease on lease.id=holder.lease_id
               where lease.sandbox_group_id=${native.sandboxGroupId}) as holders`;
    expect(legacyState).toEqual({ leases: 0, holders: 0 });
  } finally {
    await client.close();
    await fixture.release();
  }
}, 180_000);
