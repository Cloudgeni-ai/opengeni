import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  AutomationSessionTemplate,
  DEVELOPER_SETUP_API_KEY_PRESET,
  metadataWithTurnExecutionPolicyV1,
  signDelegatedAccessToken,
  type AutomationTrigger,
  type Permission,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { acceptAutomationEvent, registerAutomationRoutes } from "../src/routes/automations";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const triggerId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const turnId = "66666666-6666-4666-8666-666666666666";
const attemptId = "77777777-7777-4777-8777-777777777777";
const delegationSecret = "automation-ceiling-fixture-secret";
const settings = testSettings({ productAccessMode: "managed", delegationSecret });
const template = AutomationSessionTemplate.parse({
  prompt: "Process the event",
  sandboxBackend: "none",
});
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function fixture(restrictedExisting = false) {
  const existing: AutomationTrigger = {
    id: triggerId,
    accountId,
    workspaceId,
    sourceId,
    name: "Fixture",
    adapterId: "signed-json.v1",
    eventTypes: ["fixture.event"],
    configuration: {},
    parameters: {},
    sessionTemplate: {
      ...template,
      ...(restrictedExisting ? { credentialRestriction: "developer_setup" as const } : {}),
    },
    status: "active",
    revision: 1,
    createdBySubjectId: "fixture",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  track(
    spyOn(db, "getAutomationSourceSecret").mockResolvedValue({
      id: sourceId,
      accountId,
      workspaceId,
      adapterId: "signed-json.v1",
      status: "active",
      configuration: {},
      version: 1,
    } as never),
  );
  track(spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({ settings } as never));
  track(spyOn(db, "listAutomationTriggers").mockResolvedValue([existing]));
  const create = track(
    spyOn(db, "createAutomationTrigger").mockImplementation(async (_database, input) => ({
      ...existing,
      sessionTemplate: {
        ...input.request.sessionTemplate,
        ...(input.credentialRestriction
          ? { credentialRestriction: input.credentialRestriction }
          : {}),
      },
    })),
  );
  const update = track(
    spyOn(db, "updateAutomationTrigger").mockImplementation(async (_database, input) => ({
      ...existing,
      revision: 2,
      sessionTemplate: {
        ...(input.request.sessionTemplate ?? existing.sessionTemplate),
        ...(input.credentialRestriction
          ? { credentialRestriction: input.credentialRestriction }
          : {}),
      },
    })),
  );
  const app = new Hono();
  const dispatch = mock(async () => undefined);
  const deps = {
    db: {} as never,
    settings,
    managedAuth: null,
    workflowClient: { triggerAutomationRun: dispatch },
  } as unknown as core.ApiRouteDeps;
  registerAutomationRoutes(app, deps);
  return { app, create, update, existing, deps, dispatch };
}

function eventFixture(restrictedExisting = false) {
  const state = fixture(restrictedExisting);
  const source = {
    id: sourceId,
    accountId,
    workspaceId,
    adapterId: "signed-json.v1",
    status: "active",
    configuration: {},
    version: 1,
  } as db.AutomationSourceSecret;
  let storedEvent: db.AutomationStoredEvent | undefined;
  let storedRun: db.AutomationRunExecution | undefined;
  track(
    spyOn(db, "listActiveAutomationTriggersForSource").mockResolvedValue([
      { ...state.existing, sourceStatus: "active", sourceVersion: 1, sourceConfiguration: {} },
    ]),
  );
  track(spyOn(db, "getAutomationTriggerRevisions").mockResolvedValue([state.existing]));
  track(
    spyOn(db, "withWorkspaceGatewayCustomModelReadLock").mockImplementation(
      async (_database, _input, run) => run({} as never),
    ),
  );
  track(
    spyOn(db, "withWorkspaceOpenRouterCustomModelReadLock").mockImplementation(
      async (_database, _input, run) => run({} as never),
    ),
  );
  track(spyOn(core, "assertWorkspaceModelPolicyAllows").mockResolvedValue(undefined));
  track(spyOn(core, "canonicalConfiguredModel").mockReturnValue("scripted-model"));
  const record = track(
    spyOn(db, "recordAutomationEvent").mockImplementation(async (_database, input) => {
      if (storedEvent && storedEvent.deliveryKey === input.deliveryKey) {
        if (input.credentialRestriction && !storedEvent.normalizedEvent.credentialRestriction)
          throw new db.AutomationCredentialRestrictionConflictError();
        return { event: storedEvent, duplicate: true };
      }
      storedEvent = {
        ...input,
        id: crypto.randomUUID(),
        normalizedEvent: {
          ...input.normalizedEvent,
          ...(input.credentialRestriction
            ? { credentialRestriction: input.credentialRestriction }
            : {}),
        },
        status: input.ignoredReason ? "ignored" : "accepted",
        ignoredReason: input.ignoredReason ?? null,
        errorCode: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      return { event: storedEvent, duplicate: false };
    }),
  );
  const run = track(
    spyOn(db, "createAutomationRun").mockImplementation(async (_database, input) => {
      if (storedRun) {
        if (
          input.acceptedExecution.sessionTemplate.credentialRestriction &&
          !storedRun.acceptedExecution.sessionTemplate.credentialRestriction
        )
          throw new db.AutomationCredentialRestrictionConflictError();
        return { run: storedRun, duplicate: true };
      }
      storedRun = {
        ...input,
        id: crypto.randomUUID(),
        status: "queued",
        sessionId: null,
        errorCode: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      return { run: storedRun, duplicate: false };
    }),
  );
  return { ...state, source, record, run };
}

function manualRequest(
  app: Hono,
  token: string,
  headers: Record<string, string> = {},
  deliveryId = "manual-fixture",
) {
  return app.request(`/v1/workspaces/${workspaceId}/automations/sources/${sourceId}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({
      deliveryId,
      eventType: "fixture.event",
      occurrenceKey: "fixture:one",
      payload: { credentialRestriction: "none" },
    }),
  });
}

function rawSetupHeaders(lane: "raw" | "service" | "asUser"): Record<string, string> {
  rawSetup();
  if (lane === "service") return { "x-opengeni-service-initiator": "fixture.setup" };
  if (lane === "raw") return {};
  const externalSubjectId = "external_user:99999999-9999-4999-8999-999999999999";
  track(
    spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
      callback({} as never),
    ),
  );
  track(spyOn(db, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
  track(
    spyOn(db, "ensureExternalIdentity").mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      accountId,
      subjectId: externalSubjectId,
      source: "fixture",
      externalId: "person",
      personalWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationMembershipId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authorizationRevision: 1,
    } as never),
  );
  track(
    spyOn(db, "getWorkspaceGrant").mockResolvedValue({
      accountId,
      workspaceId,
      subjectId: externalSubjectId,
      principalKind: "human_session",
      permissions: ["workspace:admin"],
      metadata: {},
    }),
  );
  track(
    spyOn(db, "withWorkspaceSubjectRls").mockImplementation(
      async (_db, _workspace, _subject, run) => run({} as never),
    ),
  );
  return {
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source: "fixture", externalId: "person" } }),
    ),
  };
}

async function bearer(restricted: boolean, exactActor = false): Promise<string> {
  return signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId: "service:fixture",
    principalKind: exactActor ? "agent_attempt" : "service",
    permissions: [
      "workspace:admin",
      "secrets:read",
      "account:admin",
      "billing:manage",
      "api_keys:manage",
    ],
    ...(restricted ? { credentialRestriction: "developer_setup" as const } : {}),
    ...(exactActor ? { sessionId, turnId, attemptId, executionGeneration: 1 } : {}),
    exp: Math.floor(Date.now() / 1_000) + 60,
  });
}

function request(
  app: Hono,
  token: string,
  sessionTemplate: unknown,
  method = "POST",
  headers: Record<string, string> = {},
) {
  return app.request(
    `/v1/workspaces/${workspaceId}/automations/triggers${method === "PATCH" ? `/${triggerId}` : ""}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(
        method === "PATCH"
          ? { expectedRevision: 1, sessionTemplate }
          : { sourceId, name: "Fixture", eventTypes: ["fixture.event"], sessionTemplate },
      ),
    },
  );
}

function rawSetup() {
  track(
    spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      accountId,
      workspaceId: null,
      name: "Setup fixture",
      permissions: [...DEVELOPER_SETUP_API_KEY_PRESET.permissions],
      credentialKind: "organization",
    } as never),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  track(
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
}

describe("automation setup credential ceiling", () => {
  test.each(["raw", "service", "asUser"] as const)(
    "%s setup creation freezes restriction without changing template defaults",
    async (lane) => {
      const { app, create } = fixture();
      const headers = rawSetupHeaders(lane);
      const response = await request(app, "ogk_fixture_setup", template, "POST", headers);
      expect(response.status).toBe(201);
      expect(create.mock.calls[0]?.[1]).toMatchObject({
        credentialRestriction: "developer_setup",
        request: { sessionTemplate: { firstPartyMcpPermissions: [], firstPartyMcpTools: [] } },
      });
      expect(create.mock.calls[0]?.[1].request.sessionTemplate).not.toHaveProperty(
        "credentialRestriction",
      );
      expect((await response.json()).sessionTemplate.credentialRestriction).toBe("developer_setup");
    },
  );

  test("a verified setup-derived caller cannot create unrestricted automation authority", async () => {
    const { app, create } = fixture();
    const response = await request(app, await bearer(true), template);
    expect(response.status).toBe(201);
    expect(create.mock.calls[0]?.[1].credentialRestriction).toBe("developer_setup");
  });

  test.each(["turn", "session"] as const)(
    "legacy signed agent provenance inherits its frozen %s restriction",
    async (source) => {
      const { app, create } = fixture();
      const policy = resolveTurnExecutionPolicyV1(settings, {
        modelId: "scripted-model",
        requestedModelId: null,
        modelSource: "session",
        reasoningEffort: "high",
        reasoningSource: "session",
      });
      const restricted = metadataWithTurnExecutionPolicyV1(
        {},
        { ...policy, credentialRestriction: "developer_setup" },
      );
      track(
        spyOn(db, "getSessionTurnForAttempt").mockResolvedValue({
          id: turnId,
          metadata: source === "turn" ? restricted : {},
        } as never),
      );
      track(
        spyOn(db, "getSession").mockResolvedValue({
          id: sessionId,
          accountId,
          metadata: source === "session" ? restricted : {},
        } as never),
      );
      const response = await request(app, await bearer(false, true), template);
      expect(response.status).toBe(201);
      expect(create.mock.calls[0]?.[1].credentialRestriction).toBe("developer_setup");
    },
  );

  test.each([
    "api_keys:manage",
    "secrets:read",
    "account:admin",
    "billing:manage",
    "workspace:create",
  ] as const)(
    "setup cannot delegate explicit %s template scope",
    async (permission: Permission) => {
      const { app, create } = fixture();
      const response = await request(app, await bearer(true), {
        ...template,
        firstPartyMcpPermissions: [permission],
      });
      expect(response.status).toBe(403);
      expect(create).not.toHaveBeenCalled();
    },
  );

  test("non-setup scopes and defaults are unchanged, and public metadata cannot forge restriction", async () => {
    const { app, create } = fixture();
    const response = await request(app, await bearer(false), {
      ...template,
      credentialRestriction: "developer_setup",
      firstPartyMcpPermissions: ["secrets:read", "api_keys:manage", "account:admin"],
      metadata: {
        credentialRestriction: "developer_setup",
        turnExecutionPolicyV1: { credentialRestriction: "developer_setup" },
      },
    });
    expect(response.status).toBe(201);
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty("credentialRestriction");
    expect(create.mock.calls[0]?.[1].request.sessionTemplate).not.toHaveProperty(
      "credentialRestriction",
    );
    expect(create.mock.calls[0]?.[1].request.sessionTemplate.firstPartyMcpPermissions).toEqual([
      "secrets:read",
      "api_keys:manage",
      "account:admin",
    ]);
  });

  test("ordinary owner replacement cannot downgrade an existing restricted trigger", async () => {
    const { app, update } = fixture(true);
    const response = await request(app, await bearer(false), template, "PATCH");
    expect(response.status).toBe(200);
    expect(update.mock.calls[0]?.[1].credentialRestriction).toBe("developer_setup");
    expect(update.mock.calls[0]?.[1].request.sessionTemplate).not.toHaveProperty(
      "credentialRestriction",
    );
  });

  test("ordinary owners cannot add forbidden explicit scopes to an already restricted template", async () => {
    const { app, update } = fixture(true);
    const response = await request(
      app,
      await bearer(false),
      { ...template, firstPartyMcpPermissions: ["api_keys:manage"] },
      "PATCH",
    );
    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  test("a mismatched live-origin claim cannot manufacture automation authority", async () => {
    const { app, create } = fixture();
    track(
      spyOn(db, "getSessionTurnForAttempt").mockResolvedValue({
        id: crypto.randomUUID(),
        metadata: {},
      } as never),
    );
    track(
      spyOn(db, "getSession").mockResolvedValue({
        id: sessionId,
        accountId,
        metadata: {},
      } as never),
    );
    expect((await request(app, await bearer(false, true), template)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("manual automation invocation ceiling", () => {
  test.each(["raw", "service", "asUser"] as const)(
    "%s setup invoking a native template freezes only the event/run ceiling",
    async (lane) => {
      const state = eventFixture();
      const response = await manualRequest(state.app, "ogk_fixture_setup", rawSetupHeaders(lane));
      expect(response.status).toBe(202);
      expect(state.record.mock.calls[0]?.[1].credentialRestriction).toBe("developer_setup");
      const accepted = state.run.mock.calls[0]?.[1].acceptedExecution;
      expect(accepted?.sessionTemplate).toEqual({
        ...template,
        credentialRestriction: "developer_setup",
      });
      expect(state.existing.sessionTemplate).not.toHaveProperty("credentialRestriction");
      expect(state.create).not.toHaveBeenCalled();
      expect(state.update).not.toHaveBeenCalled();
      expect(state.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  test("verified setup-derived manual caller is restricted and later ordinary replay retains it", async () => {
    const state = eventFixture();
    expect((await manualRequest(state.app, await bearer(true))).status).toBe(202);
    expect((await manualRequest(state.app, await bearer(false))).status).toBe(202);
    expect(state.record.mock.calls[1]?.[1].credentialRestriction).toBeUndefined();
    expect(
      state.run.mock.calls[1]?.[1].acceptedExecution.sessionTemplate.credentialRestriction,
    ).toBe("developer_setup");
    expect(state.dispatch).toHaveBeenCalledTimes(2);
  });

  test("restricted manual invocation rejects native explicit broad scopes before event/run writes", async () => {
    const state = eventFixture();
    state.existing.sessionTemplate.firstPartyMcpPermissions = ["api_keys:manage"];
    expect((await manualRequest(state.app, await bearer(true))).status).toBe(403);
    expect(state.record).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  test("ordinary native manual invocation keeps broad explicit scopes and no marker", async () => {
    const state = eventFixture();
    state.existing.sessionTemplate.firstPartyMcpPermissions = ["api_keys:manage"];
    expect((await manualRequest(state.app, await bearer(false))).status).toBe(202);
    expect(state.record.mock.calls[0]?.[1].credentialRestriction).toBeUndefined();
    expect(state.run.mock.calls[0]?.[1].acceptedExecution.sessionTemplate).toMatchObject({
      firstPartyMcpPermissions: ["api_keys:manage"],
    });
    expect(state.run.mock.calls[0]?.[1].acceptedExecution.sessionTemplate).not.toHaveProperty(
      "credentialRestriction",
    );
  });

  test.each(["same-delivery", "same-occurrence"] as const)(
    "restricted %s cannot adopt a previously unrestricted snapshot",
    async (collision) => {
      const state = eventFixture();
      expect((await manualRequest(state.app, await bearer(false))).status).toBe(202);
      const response = await manualRequest(
        state.app,
        await bearer(true),
        {},
        collision === "same-delivery" ? "manual-fixture" : "new-delivery",
      );
      expect(response.status).toBe(409);
      expect(state.dispatch).toHaveBeenCalledTimes(1);
      expect(state.existing.sessionTemplate).not.toHaveProperty("credentialRestriction");
    },
  );

  test("adapter-normalized authority forgery is stripped rather than tainting native acceptance", async () => {
    const state = eventFixture();
    await acceptAutomationEvent(state.deps, state.source, {
      deliveryKey: "webhook-fixture",
      requestDigest: "a".repeat(64),
      normalizedEvent: {
        adapterId: "signed-json.v1",
        eventType: "fixture.event",
        occurrenceKey: "fixture:one",
        occurredAt: null,
        subject: null,
        resource: null,
        payload: { credentialRestriction: "developer_setup" },
        credentialRestriction: "developer_setup",
      },
    });
    expect(state.record.mock.calls[0]?.[1].normalizedEvent).not.toHaveProperty(
      "credentialRestriction",
    );
    expect(state.run.mock.calls[0]?.[1].acceptedExecution.sessionTemplate).not.toHaveProperty(
      "credentialRestriction",
    );
  });
});
