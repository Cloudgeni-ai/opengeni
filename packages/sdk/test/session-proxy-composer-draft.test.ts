import { describe, expect, test } from "bun:test";
import {
  ComposerDraft,
  SaveComposerDraftRequest,
  SubmitComposerDraftRequest,
} from "@opengeni/contracts";
import { OpenGeniEmbeddingClient as OpenGeniClient } from "../src/embedding-client";
import { createSessionProxyHandler, type SessionProxyHandlerOptions } from "../src/session-proxy";
import type { ComposerDraft as SdkComposerDraft } from "../src/types";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const API = "https://api.example.test";
const PRODUCT = "https://product.example.test/api/opengeni";
const DRAFT_PATH = `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/composer-draft`;
const HOST_POLICY = {
  model: "host-model",
  reasoningEffort: "medium",
  latencyMode: "standard",
} as const;
const CLIENT_POLICY = {
  model: "client-model",
  reasoningEffort: "xhigh",
  latencyMode: "fast",
} as const;
type Policy = Pick<ComposerDraft, "model" | "reasoningEffort" | "latencyMode">;
type Recorded = { method: string; path: string; headers: Headers; body: Record<string, unknown> };

/** Real request schemas and the API's revision/content fence, without a worker or live model. */
function fixture(options: Partial<SessionProxyHandlerOptions> = {}, policy: Policy = HOST_POLICY) {
  const requests: Recorded[] = [];
  let sessionPolicy = policy;
  let draft: ComposerDraft = ComposerDraft.parse({
    revision: 0,
    text: "",
    annotations: [],
    resources: [],
    ...policy,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  });
  let readStatus = 200;
  const receipts = new Map<string, { hash: string; response: Record<string, unknown> }>();
  const failure = (status: number, code: string) => Response.json({ error: { code } }, { status });
  const content = (value: SaveComposerDraftRequest) => ({
    text: value.text,
    annotations: value.annotations,
    resources: value.resources,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    latencyMode: value.latencyMode,
  });
  const service = new OpenGeniClient({
    baseUrl: API,
    apiKey: "test-host-key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const text = await request.text();
      const body = text ? JSON.parse(text) : {};
      requests.push({ method: request.method, path, headers: request.headers, body });
      if (path === DRAFT_PATH && request.method === "GET") {
        return readStatus === 200
          ? Response.json(draft.revision === 0 ? { ...draft, ...sessionPolicy } : draft)
          : failure(readStatus, "draft_unavailable");
      }
      if (path === DRAFT_PATH && request.method === "PUT") {
        const parsed = SaveComposerDraftRequest.safeParse(body);
        if (!parsed.success) return failure(400, "invalid_draft");
        if (parsed.data.expectedRevision !== draft.revision) return failure(409, "DRAFT_CHANGED");
        draft = { ...draft, ...content(parsed.data), revision: draft.revision + 1 };
        return Response.json(draft);
      }
      if (path === `${DRAFT_PATH}/submit` && request.method === "POST") {
        const parsed = SubmitComposerDraftRequest.safeParse(body);
        if (!parsed.success) return failure(400, "invalid_submit");
        const hash = JSON.stringify(parsed.data);
        const previous = receipts.get(parsed.data.clientEventId);
        if (previous) {
          return previous.hash === hash
            ? Response.json({ ...previous.response, replay: true })
            : failure(409, "IDEMPOTENCY_KEY_REUSED");
        }
        if (
          parsed.data.expectedDraftRevision !== draft.revision ||
          JSON.stringify(content({ ...parsed.data, expectedRevision: draft.revision })) !==
            JSON.stringify(content({ ...draft, expectedRevision: draft.revision }))
        ) {
          return failure(409, "DRAFT_CHANGED");
        }
        draft = {
          ...draft,
          revision: draft.revision + 1,
          text: "",
          annotations: [],
          resources: [],
        };
        const response = { draft, replay: false };
        receipts.set(parsed.data.clientEventId, { hash, response });
        return Response.json(response);
      }
      return failure(404, "unexpected_route");
    },
  });
  const handler = createSessionProxyHandler(service, {
    resolve: () => ({ workspaceId: WORKSPACE_ID, user: "host-user", source: "host-source" }),
    modelSelection: false,
    ...options,
  });
  const browser = new OpenGeniClient({
    baseUrl: PRODUCT,
    fetch: (input, init) => handler(new Request(input, init)),
  });
  return {
    browser,
    handler,
    requests,
    setReadStatus: (status: number) => (readStatus = status),
    setSessionPolicy: (next: Policy) => (sessionPolicy = next),
    seedDraft: (value: ComposerDraft) => (draft = ComposerDraft.parse(value)),
  };
}

function saveInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 0,
    text: "Draft text",
    annotations: [],
    resources: [],
    ...CLIENT_POLICY,
    ...overrides,
  };
}

function submitInput(draft: SdkComposerDraft, overrides: Record<string, unknown> = {}) {
  return {
    expectedDraftRevision: draft.revision,
    clientEventId: "submit-once",
    delivery: "send" as const,
    text: draft.text,
    annotations: draft.annotations,
    resources: draft.resources,
    ...CLIENT_POLICY,
    ...overrides,
  };
}

describe("session proxy locked-model composer draft", () => {
  test("submits an already-saved draft without accepting browser model policy", async () => {
    const f = fixture();
    const saved = ComposerDraft.parse({
      revision: 3,
      text: "Already saved",
      annotations: [],
      resources: [],
      ...HOST_POLICY,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    });
    f.seedDraft(saved);
    const submitted = await f.browser.submitComposerDraft(
      WORKSPACE_ID,
      SESSION_ID,
      submitInput(saved),
    );
    expect(submitted.draft.revision).toBe(4);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(f.requests[1]!.body).toEqual({ ...submitInput(saved), ...HOST_POLICY });
  });

  test.each([
    HOST_POLICY,
    { model: "host-priority", reasoningEffort: "high", latencyMode: "priority" } as const,
    { model: "host-fast", reasoningEffort: "max", latencyMode: "fast" } as const,
  ])("save and submit use the authoritative draft policy: %j", async (policy) => {
    const f = fixture({}, policy);
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
    expect(saved).toMatchObject({ revision: 1, text: "Draft text", ...policy });
    const submitted = await f.browser.submitComposerDraft(
      WORKSPACE_ID,
      SESSION_ID,
      submitInput(saved),
    );
    expect(submitted.draft.revision).toBe(2);
    for (const request of f.requests) {
      expect(
        JSON.parse(decodeURIComponent(request.headers.get("x-opengeni-external-actor")!)),
      ).toEqual({
        mode: "external",
        identity: { externalId: "host-user", source: "host-source" },
      });
      if (request.method !== "GET") expect(request.body).toMatchObject(policy);
    }
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT", "GET", "POST"]);
  });

  test.each(["send", "steer"] as const)(
    "%s preserves submit fences, extras and immediate replay",
    async (delivery) => {
      const f = fixture({
        beforeForwardMessage: () => ({
          modelContext: "host context",
          mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "test-host-token" } }],
        }),
      });
      const saved = await f.browser.saveComposerDraft(
        WORKSPACE_ID,
        SESSION_ID,
        saveInput({
          resources: [{ kind: "file", fileId: "22222222-2222-4222-8222-222222222222" }],
        }),
      );
      // A saved draft is a frozen policy snapshot, not mutable session defaults.
      f.setSessionPolicy(CLIENT_POLICY);
      const input = submitInput(saved, {
        delivery,
        controlEtag: "control-1",
        modelContext: "browser context",
      });
      const first = await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, input);
      const replay = await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, input);
      expect(first.replay).toBe(false);
      expect(replay.replay).toBe(true);
      expect(replay.draft).toEqual(first.draft);
      const submits = f.requests.filter(({ method }) => method === "POST");
      expect(submits[0]!.body).toEqual(submits[1]!.body);
      expect(submits[0]!.body).toEqual({
        ...input,
        ...HOST_POLICY,
        modelContext: "host context\n\nbrowser context",
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "test-host-token" } }],
      });
      await expect(
        f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, { ...input, text: "changed" }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  test.each([
    {},
    { model: null, reasoningEffort: null, latencyMode: null },
    { model: {}, reasoningEffort: 1, latencyMode: "invalid" },
  ])("locked policy never falls back to browser values: %j", async (policy) => {
    const f = fixture();
    const {
      model: _model,
      reasoningEffort: _reasoning,
      latencyMode: _latency,
      ...input
    } = saveInput();
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
      ...input,
      ...policy,
    } as never);
    expect(saved).toMatchObject(HOST_POLICY);
    const submit = submitInput(saved);
    const {
      model: _submitModel,
      reasoningEffort: _submitReasoning,
      latencyMode: _submitLatency,
      ...submitWithoutPolicy
    } = submit;
    expect(
      (
        await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
          ...submitWithoutPolicy,
          ...policy,
        } as never)
      ).replay,
    ).toBe(false);
  });

  test.each([true, undefined])(
    "unlocked model selection %j stays unchanged without a policy lookup",
    async (modelSelection) => {
      const f = fixture({ modelSelection });
      const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
      expect(saved).toMatchObject(CLIENT_POLICY);
      await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved));
      expect(f.requests.map(({ method }) => method)).toEqual(["PUT", "POST"]);
      expect(f.requests[0]!.body).toEqual(saveInput());
    },
  );

  test("stale revisions and content mismatches remain API conflicts", async () => {
    const f = fixture();
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
    await expect(
      f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput()),
    ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
    await expect(
      f.browser.submitComposerDraft(
        WORKSPACE_ID,
        SESSION_ID,
        submitInput(saved, { text: "not saved" }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
    await expect(
      f.browser.submitComposerDraft(
        WORKSPACE_ID,
        SESSION_ID,
        submitInput(saved, { expectedDraftRevision: saved.revision + 1 }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
  });

  test.each([403, 404, 503])(
    "policy read failure %i fails closed without a write",
    async (status) => {
      const f = fixture();
      f.setReadStatus(status);
      for (const [method, suffix, body] of [
        ["PUT", "", saveInput()],
        [
          "POST",
          "/submit",
          { ...saveInput(), expectedDraftRevision: 1, clientEventId: "submit", delivery: "send" },
        ],
      ] as const) {
        const response = await f.handler(
          new Request(`${PRODUCT}${DRAFT_PATH}${suffix}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        expect(response.status).toBe(status);
      }
      expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    },
  );

  test("host authentication, session and mutation authorization deny before policy reads", async () => {
    for (const [options, status] of [
      [{ resolve: () => new Response("Unauthorized", { status: 401 }) }, 401],
      [{ authorizeSession: () => false }, 404],
      [{ authorizeMutation: () => false }, 403],
    ] as const) {
      const f = fixture(options);
      await expect(
        f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput()),
      ).rejects.toMatchObject({ status });
      await expect(
        f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
          ...saveInput(),
          expectedDraftRevision: 1,
          clientEventId: "submit",
          delivery: "send",
        }),
      ).rejects.toMatchObject({ status });
      expect(f.requests).toHaveLength(0);
    }
  });

  test("drafts cannot rotate browser credentials or add non-file resources", async () => {
    for (const forbidden of [
      { mcpCredentialUpdates: [{ serverId: "crm", headers: { Authorization: "browser-token" } }] },
      { resources: [{ kind: "repository", url: "https://github.com/acme/secret" }] },
    ]) {
      const f = fixture();
      await expect(
        f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput(forbidden) as never),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
          ...saveInput(forbidden),
          expectedDraftRevision: 1,
          clientEventId: "submit",
          delivery: "send",
        } as never),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(0);
    }
  });

  test("a submit refused by the host hook does not read or write a draft", async () => {
    const f = fixture({
      beforeForwardMessage: () => new Response("Unauthorized", { status: 401 }),
    });
    await expect(
      f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
        ...saveInput(),
        expectedDraftRevision: 1,
        clientEventId: "submit",
        delivery: "send",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.requests).toHaveLength(0);
  });
});
