import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant, type Permission } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  EditableArtifactCompatibilityError,
  type EditableArtifactApplicationPort,
} from "@opengeni/core";
import { Hono } from "hono";

import {
  EDITABLE_ARTIFACT_LIVE_TICKET_REQUEST_MAX_BYTES,
  EditableArtifactApplicationError,
  editableArtifactActorForGrant,
  registerEditableArtifactRoutes,
} from "../src/routes/editable-artifacts";

const SECRET = "editable-artifact-route-test-secret";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const ARTIFACT_ID = "1".repeat(32);
const REPLICA_ID = "2".repeat(16);
const SESSION_ID = "30000000-0000-4000-8000-000000000003";
const TURN_ID = "40000000-0000-4000-8000-000000000004";
const ATTEMPT_ID = "50000000-0000-4000-8000-000000000005";

type RecordedApplication = {
  app: Hono;
  calls: Array<Parameters<EditableArtifactApplicationPort["mintLiveTicket"]>[0]>;
  createCalls: Array<Parameters<EditableArtifactApplicationPort["createArtifact"]>[0]>;
  readCalls: Array<Parameters<EditableArtifactApplicationPort["readArtifact"]>[0]>;
  failWith: { value: Error | null };
};

function routeFixture(
  options: Readonly<{
    modality?: "document" | "spreadsheet" | "presentation";
    ticketProtocolVersion?: number;
    uncomposed?: boolean;
  }> = {},
): RecordedApplication {
  const modality = options.modality ?? "spreadsheet";
  const calls: RecordedApplication["calls"] = [];
  const createCalls: RecordedApplication["createCalls"] = [];
  const readCalls: RecordedApplication["readCalls"] = [];
  const failWith = { value: null as Error | null };
  const application = {
    createArtifact: async (input) => {
      createCalls.push(input);
      if (failWith.value) throw failWith.value;
      return artifactResult(modality);
    },
    readArtifact: async (input) => {
      readCalls.push(input);
      if (failWith.value) throw failWith.value;
      return artifactResult(modality);
    },
    mintLiveTicket: async (input) => {
      calls.push(input);
      if (failWith.value) throw failWith.value;
      return {
        artifactId: input.artifactId,
        modality,
        replicaId: input.actor.replicaId,
        token: "ticket.valid_value",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        protocolVersion: options.ticketProtocolVersion ?? input.protocolVersion,
      };
    },
    openLive: async () => {
      throw new Error("unused");
    },
  } satisfies EditableArtifactApplicationPort;
  const app = new Hono();
  registerEditableArtifactRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
    }),
    db: {} as never,
    managedAuth: null,
    ...(options.uncomposed ? {} : { editableArtifacts: application }),
  });
  return { app, calls, createCalls, readCalls, failWith };
}

function artifactResult(modality: "document" | "spreadsheet" | "presentation" = "spreadsheet") {
  const common = {
    scope: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
    id: ARTIFACT_ID,
    modality,
    title: "Forecast",
    lifecycle: "active",
    authorizationRevision: 1,
    headSequence: 0,
    stateHash: `sha256:${"0".repeat(64)}`,
    currentSnapshotId: "3".repeat(32),
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
  };
  return (
    modality === "spreadsheet" ? { ...common, modality, causalFrontier: [] } : common
  ) as never;
}

async function bearer(
  input: {
    principalKind?: "human_session" | "agent_attempt" | "service";
    permissions?: Permission[];
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    executionGeneration?: number;
    serviceInitiator?: { kind: "service"; subjectId: string; label?: string };
  } = {},
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: "user:artifact-test",
    permissions: input.permissions ?? ["artifacts:read", "artifacts:publish"],
    principalKind: input.principalKind ?? "human_session",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.executionGeneration ? { executionGeneration: input.executionGeneration } : {}),
    ...(input.serviceInitiator ? { serviceInitiator: input.serviceInitiator } : {}),
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

function ticketBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    replicaId: REPLICA_ID,
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-1",
    modelSchemaVersion: 1,
    ...extra,
  });
}

async function mint(
  fixture: RecordedApplication,
  options: {
    authorization?: string;
    body?: string;
    artifactId?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization) headers.set("authorization", options.authorization);
  return await fixture.app.request(
    `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${options.artifactId ?? ARTIFACT_ID}/live-ticket`,
    {
      method: "POST",
      headers,
      body: options.body ?? ticketBody(),
    },
  );
}

async function createArtifact(
  fixture: RecordedApplication,
  authorization: string,
): Promise<Response> {
  return await fixture.app.request(
    `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        replicaId: REPLICA_ID,
        idempotencyKey: "create-1",
        modality: "spreadsheet",
        title: "Forecast",
      }),
    },
  );
}

describe("editable artifact create/open routes", () => {
  test("parses bounded create bodies from Bun's real HTTP request stream", async () => {
    const fixture = routeFixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: fixture.app.fetch,
    });
    try {
      const response = await fetch(
        new URL(`/v1/workspaces/${WORKSPACE_ID}/editable-artifacts`, server.url),
        {
          method: "POST",
          headers: {
            authorization: await bearer(),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            replicaId: REPLICA_ID,
            idempotencyKey: "bun-http-create",
            modality: "document",
            title: "Real request stream",
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(fixture.createCalls).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("creates verified genesis through the application and returns bounded metadata", async () => {
    const fixture = routeFixture();
    const response = await createArtifact(fixture, await bearer());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      id: ARTIFACT_ID,
      modality: "spreadsheet",
      title: "Forecast",
      lifecycle: "active",
      headSequence: 0,
      stateHash: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    });
    expect(fixture.createCalls[0]).toMatchObject({
      scope: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
      actor: { kind: "human", replicaId: REPLICA_ID },
      idempotencyKey: "create-1",
      modality: "spreadsheet",
      title: "Forecast",
    });
  });

  test("opens metadata under exact artifact authorization", async () => {
    const fixture = routeFixture();
    const response = await fixture.app.request(
      `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}?replicaId=${REPLICA_ID}`,
      { headers: { authorization: await bearer() } },
    );
    expect(response.status).toBe(200);
    expect(fixture.readCalls[0]).toMatchObject({
      scope: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
      artifactId: ARTIFACT_ID,
      actor: { kind: "human", replicaId: REPLICA_ID },
    });
  });

  test.each([
    [" padded", 422],
    ["padded ", 422],
    ["\ud800", 422],
    ["😀".repeat(129), 422],
    ["😀".repeat(128), 201],
  ] as const)("enforces the domain title boundary for %j", async (title, status) => {
    const fixture = routeFixture();
    const response = await fixture.app.request(
      `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "content-type": "application/json",
        },
        body:
          title === "\ud800"
            ? `{"replicaId":"${REPLICA_ID}","idempotencyKey":"title-boundary","modality":"spreadsheet","title":"\\ud800"}`
            : JSON.stringify({
                replicaId: REPLICA_ID,
                idempotencyKey: "title-boundary",
                modality: "spreadsheet",
                title,
              }),
      },
    );
    expect(response.status).toBe(status);
    expect(fixture.createCalls).toHaveLength(status === 201 ? 1 : 0);
  });
});

describe("editable artifact live-ticket route", () => {
  test("keeps the API available while the uncomposed artifact engine fails closed", async () => {
    const fixture = routeFixture({ uncomposed: true });
    const response = await mint(fixture, { authorization: await bearer() });
    expect(response.status).toBe(503);
    expect(fixture.calls).toHaveLength(0);
  });

  test("authenticates before reading or validating the request", async () => {
    const fixture = routeFixture();
    const response = await mint(fixture, {
      artifactId: "not-an-artifact-id",
      body: "x".repeat(EDITABLE_ARTIFACT_LIVE_TICKET_REQUEST_MAX_BYTES + 1),
    });
    expect(response.status).toBe(401);
    expect(fixture.calls).toHaveLength(0);
  });

  test("derives human authority and passes a bounded immutable request to the application", async () => {
    const fixture = routeFixture();
    const response = await mint(fixture, {
      authorization: await bearer({ permissions: ["artifacts:read"] }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet",
      replicaId: REPLICA_ID,
      token: "ticket.valid_value",
      protocolVersion: 1,
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      artifactId: ARTIFACT_ID,
      protocolVersion: 1,
      kernelVersion: "artifact-kernel-1",
      modelSchemaVersion: 1,
      scope: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
      actor: {
        kind: "human",
        subjectId: "user:artifact-test",
        replicaId: REPLICA_ID,
      },
    });
    expect(Object.isFrozen(fixture.calls[0]!.scope)).toBe(true);
    expect(Object.isFrozen(fixture.calls[0]!.actor)).toBe(true);
  });

  test("accepts the real kernel identity budget and rejects one byte beyond it", async () => {
    const accepted = routeFixture();
    const acceptedResponse = await mint(accepted, {
      authorization: await bearer(),
      body: ticketBody({ kernelVersion: "k".repeat(512) }),
    });
    expect(acceptedResponse.status).toBe(201);
    expect(accepted.calls[0]?.kernelVersion).toBe("k".repeat(512));

    const rejected = routeFixture();
    const rejectedResponse = await mint(rejected, {
      authorization: await bearer(),
      body: ticketBody({ kernelVersion: "k".repeat(513) }),
    });
    expect(rejectedResponse.status).toBe(422);
    expect(rejected.calls).toHaveLength(0);
  });

  test.each(["document", "presentation"] as const)(
    "preserves durable %s modality in the live ticket response",
    async (modality) => {
      const fixture = routeFixture({ modality });
      const response = await mint(fixture, { authorization: await bearer() });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        artifactId: ARTIFACT_ID,
        modality,
        replicaId: REPLICA_ID,
        protocolVersion: 1,
      });
    },
  );

  test("rejects an application ticket for a different protocol version", async () => {
    const fixture = routeFixture({ ticketProtocolVersion: 2 });
    const response = await mint(fixture, { authorization: await bearer() });
    expect(response.status).toBe(500);
  });

  test("derives exact signed agent-attempt authority", async () => {
    const fixture = routeFixture();
    const response = await mint(fixture, {
      authorization: await bearer({
        principalKind: "agent_attempt",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        attemptId: ATTEMPT_ID,
        executionGeneration: 7,
      }),
    });

    expect(response.status).toBe(201);
    expect(fixture.calls[0]!.actor).toEqual({
      kind: "agent",
      subjectId: "user:artifact-test",
      replicaId: REPLICA_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      generation: 7,
    });
  });

  test("rejects unknown body fields instead of accepting client-authored authority", async () => {
    const fixture = routeFixture();
    const response = await mint(fixture, {
      authorization: await bearer(),
      body: ticketBody({ actor: { kind: "service", subjectId: "forged" } }),
    });
    expect(response.status).toBe(422);
    expect(fixture.calls).toHaveLength(0);
  });

  test("enforces its own body byte ceiling even without global middleware", async () => {
    const fixture = routeFixture();
    const response = await mint(fixture, {
      authorization: await bearer(),
      body: JSON.stringify({
        padding: "x".repeat(EDITABLE_ARTIFACT_LIVE_TICKET_REQUEST_MAX_BYTES),
      }),
    });
    expect(response.status).toBe(413);
    expect(fixture.calls).toHaveLength(0);
  });

  test("maps deliberate application errors to stable HTTP statuses", async () => {
    const cases = [
      ["not_found", 404],
      ["forbidden", 403],
      ["conflict", 409],
      ["unsupported_protocol", 409],
      ["limit_exceeded", 429],
      ["unavailable", 503],
    ] as const;

    for (const [code, status] of cases) {
      const fixture = routeFixture();
      fixture.failWith.value = new EditableArtifactApplicationError(code);
      const response = await mint(fixture, { authorization: await bearer() });
      expect(response.status).toBe(status);
      expect(fixture.calls).toHaveLength(1);
    }
  });

  test("maps a production compatibility mismatch to a non-retryable conflict", async () => {
    const fixture = routeFixture();
    fixture.failWith.value = new EditableArtifactCompatibilityError();
    const response = await mint(fixture, { authorization: await bearer() });
    expect(response.status).toBe(409);
  });
});

describe("editableArtifactActorForGrant", () => {
  test("maps service and key principals without trusting client actor fields", () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      subjectId: "host:automation",
      permissions: ["workspace:read"] as Permission[],
    };
    expect(
      editableArtifactActorForGrant(
        {
          ...base,
          principalKind: "service",
          serviceInitiator: { kind: "service", subjectId: "calendar-sync" },
        },
        REPLICA_ID,
      ),
    ).toEqual({
      kind: "service",
      subjectId: "host:automation",
      replicaId: REPLICA_ID,
      service: "delegated_service",
    });
    expect(
      editableArtifactActorForGrant(
        { ...base, subjectId: "api_key:123", principalKind: "api_key" },
        REPLICA_ID,
      ),
    ).toEqual({
      kind: "service",
      subjectId: "api_key:123",
      replicaId: REPLICA_ID,
      service: "api_key",
    });
    expect(
      editableArtifactActorForGrant(
        {
          ...base,
          subjectId: "api_key:00000000-0000-4000-8000-000000000001",
          principalKind: "service",
          serviceInitiator: { kind: "service", subjectId: "api_key" },
        },
        REPLICA_ID,
      ),
    ).toEqual({
      kind: "service",
      subjectId: "api_key:00000000-0000-4000-8000-000000000001",
      replicaId: REPLICA_ID,
      service: "delegated_service",
    });
  });

  test("fails closed for missing or contradictory principal provenance", () => {
    const grant = {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      subjectId: "user:artifact-test",
      permissions: ["workspace:read"] as Permission[],
    } satisfies AccessGrant;
    expect(() => editableArtifactActorForGrant(grant, REPLICA_ID)).toThrow();
    expect(() =>
      editableArtifactActorForGrant(
        {
          ...grant,
          principalKind: "human_session",
          metadata: { attemptId: ATTEMPT_ID },
        },
        REPLICA_ID,
      ),
    ).toThrow();
  });
});
