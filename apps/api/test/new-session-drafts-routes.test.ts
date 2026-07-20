import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { SaveNewSessionDraftRequest } from "@opengeni/contracts";
import type { AccessGrant, ApiRouteDeps } from "@opengeni/core";
import { NewSessionDraftConflictError } from "@opengeni/db";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";

const delegationSecret = "new-session-drafts-route-secret";
const workspaceId = "00000000-0000-4000-8000-0000000000d1";
const accountId = "00000000-0000-4000-8000-0000000000d2";
const subjectId = "user:private-draft-owner";
const fakeDb = {};

const realCore = await import("@opengeni/core");
const realCoreFns = {
  getActorNewSessionDraft: realCore.getActorNewSessionDraft,
  saveActorNewSessionDraft: realCore.saveActorNewSessionDraft,
};
let lastGetGrant: AccessGrant | null = null;
let lastSaveGrant: AccessGrant | null = null;
let lastSaveInput: Record<string, unknown> | null = null;
let rejectSave = false;

mock.module("@opengeni/core", () => ({
  ...realCore,
  getActorNewSessionDraft: async (
    deps: Parameters<typeof realCore.getActorNewSessionDraft>[0],
    grant: AccessGrant,
    candidateWorkspaceId: string,
  ) => {
    if (deps.db !== fakeDb || candidateWorkspaceId !== workspaceId) {
      return await realCoreFns.getActorNewSessionDraft(deps, grant, candidateWorkspaceId);
    }
    lastGetGrant = grant;
    return {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "high" as const,
      options: {},
      updatedAt: null,
    };
  },
  saveActorNewSessionDraft: async (
    deps: Parameters<typeof realCore.saveActorNewSessionDraft>[0],
    grant: AccessGrant,
    candidateWorkspaceId: string,
    input: unknown,
  ) => {
    if (deps.db !== fakeDb || candidateWorkspaceId !== workspaceId) {
      return await realCoreFns.saveActorNewSessionDraft(deps, grant, candidateWorkspaceId, input);
    }
    const parsed = SaveNewSessionDraftRequest.parse(input);
    lastSaveGrant = grant;
    lastSaveInput = parsed as Record<string, unknown>;
    if (rejectSave) throw new NewSessionDraftConflictError(4);
    const request = parsed as {
      expectedRevision: number;
      text: string;
      resources: [];
      tools: [];
      model: string;
      reasoningEffort: "high";
      options: {};
    };
    return {
      revision: request.expectedRevision + 1,
      text: request.text,
      resources: request.resources,
      tools: request.tools,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      options: request.options,
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
  },
}));

const { registerSessionRoutes } = await import("../src/routes/sessions");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  lastGetGrant = null;
  lastSaveGrant = null;
  lastSaveInput = null;
  rejectSave = false;
});

async function bearer(permissions: string[]) {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function app(): Hono {
  const instance = new Hono();
  registerSessionRoutes(instance, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret }),
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

describe("new-session draft routes", () => {
  test("GET requires read permission and derives the actor only from the grant", async () => {
    const response = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      { headers: { authorization: await bearer(["sessions:read"]) } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      options: {},
      updatedAt: null,
    });
    expect(lastGetGrant?.subjectId).toBe(subjectId);

    const forbidden = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      { headers: { authorization: await bearer(["sessions:create"]) } },
    );
    expect(forbidden.status).toBe(403);
  });

  test("PUT requires create permission and cannot accept a request actor override", async () => {
    const response = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["sessions:create"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 0,
          subjectId: "attacker-controlled",
          text: "private draft",
          resources: [],
          tools: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          options: {},
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 1, text: "private draft" });
    expect(lastSaveGrant?.subjectId).toBe(subjectId);
    expect(lastSaveInput).not.toHaveProperty("subjectId");

    const forbidden = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["sessions:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(forbidden.status).toBe(403);
  });

  test("PUT returns the stable typed conflict envelope with the current revision", async () => {
    rejectSave = true;
    const response = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["sessions:create"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 2,
          text: "stale",
          resources: [],
          tools: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          options: {},
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "NEW_SESSION_DRAFT_CONFLICT",
      message: "New-session draft changed in another client",
      currentRevision: 4,
    });
  });

  test("PUT returns stable value-free 422 JSON for malformed bodies", async () => {
    const malformedJson = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["sessions:create"]),
          "content-type": "application/json",
        },
        body: '{"text":',
      },
    );
    expect(malformedJson.status).toBe(422);
    expect(await malformedJson.json()).toEqual({
      code: "INVALID_NEW_SESSION_DRAFT_REQUEST",
      message: "Invalid new-session draft request: request body must contain valid JSON",
    });

    const privateValue = "do-not-reflect-this-private-draft";
    const malformedSchema = await app().request(
      `http://x/v1/workspaces/${workspaceId}/new-session-draft`,
      {
        method: "PUT",
        headers: {
          authorization: await bearer(["sessions:create"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: { privateValue } }),
      },
    );
    expect(malformedSchema.status).toBe(422);
    const raw = await malformedSchema.text();
    expect(raw).not.toContain(privateValue);
    expect(JSON.parse(raw)).toEqual({
      code: "INVALID_NEW_SESSION_DRAFT_REQUEST",
      message:
        "Invalid new-session draft request: text, resources, tools, model, reasoningEffort, and 2 more failed schema validation",
    });
  });
});
