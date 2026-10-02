import { describe, expect, test } from "bun:test";
import {
  ComposerDraft,
  EditSessionQueueItemRequest,
  SaveComposerDraftRequest,
  SessionCommandReceipt,
  SubmitComposerDraftRequest,
} from "@opengeni/contracts";
import { canonicalSessionCommandHash } from "../../db/src/session-control";
import { OpenGeniEmbeddingClient as OpenGeniClient } from "../src/embedding-client";
import { createSessionProxyHandler, type SessionProxyHandlerOptions } from "../src/session-proxy";
import type { ComposerDraft as SdkComposerDraft } from "../src/types";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const API = "https://api.example.test";
const PRODUCT = "https://product.example.test/api/opengeni";
const DRAFT_PATH = `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/composer-draft`;
const QUEUED_TURN_ID = "33333333-3333-4333-8333-333333333333";
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

/** Real schemas/hash with an in-memory API revision/content/receipt boundary; no live model. */
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
  let beforeWrite: (() => Promise<unknown>) | undefined;
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
  // Same parsed prompt-boundary fields as core/domain/sessions.ts, before mutable enrichment.
  const boundaryHash = (value: SubmitComposerDraftRequest) =>
    `prompt-boundary-v1:${canonicalSessionCommandHash({
      delivery: value.delivery,
      controlEtag: value.controlEtag ?? null,
      expectedDraftRevision: value.expectedDraftRevision,
      ...content({ ...value, expectedRevision: value.expectedDraftRevision }),
      modelContext: value.modelContext ?? null,
      composerDraftResourcesProvided: false,
      composerDraftResources: [],
      source: "user",
      mcpCredentialUpdates: value.mcpCredentialUpdates ?? [],
      connectionAccounts: value.connectionAccounts,
      personalResourceAttachment: value.personalResourceAttachment ?? null,
    })}`;
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
      if (request.method !== "GET" && beforeWrite) {
        const hook = beforeWrite;
        beforeWrite = undefined;
        await hook();
      }
      if (
        path ===
          `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue/${QUEUED_TURN_ID}/edit` &&
        request.method === "POST"
      ) {
        const parsed = EditSessionQueueItemRequest.safeParse(body);
        if (!parsed.success) return failure(400, "invalid_queue_edit");
        if (parsed.data.expectedDraftRevision !== draft.revision) {
          return failure(409, "DRAFT_CHANGED");
        }
        if (parsed.data.expectedTurnVersion !== 1) return failure(409, "PROMPT_CHANGED");
        if (draft.text && !parsed.data.replaceDraft) return failure(409, "DRAFT_NOT_EMPTY");
        draft = {
          ...draft,
          ...CLIENT_POLICY,
          text: "Queued under another policy",
          resources: [],
          annotations: [],
          revision: draft.revision + 1,
          sourceTurnId: QUEUED_TURN_ID,
          sourceTurnVersion: 1,
        };
        return Response.json({ draft, replay: false });
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
        const hash = boundaryHash(parsed.data);
        const previous = receipts.get(parsed.data.clientEventId);
        if (previous) {
          return previous.hash === hash
            ? Response.json({ ...previous.response, replay: true })
            : failure(409, "IDEMPOTENCY_KEY_REUSED");
        }
        if (
          parsed.data.expectedDraftRevision !== draft.revision ||
          canonicalSessionCommandHash(
            content({ ...parsed.data, expectedRevision: draft.revision }),
          ) !== canonicalSessionCommandHash(content({ ...draft, expectedRevision: draft.revision }))
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
        const response = {
          draft,
          receipt: SessionCommandReceipt.parse({
            id: crypto.randomUUID(),
            action: `prompt.${parsed.data.delivery}`,
            operationKey: parsed.data.clientEventId,
            targetSessionId: SESSION_ID,
            targetTurnId: crypto.randomUUID(),
            appliedControlRevision: 0,
            appliedQueueVersion: receipts.size + 1,
            appliedTurnVersion: 1,
            appliedDraftRevision: draft.revision,
            createdAt: new Date().toISOString(),
          }),
          replay: false,
        };
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
    actor: service.asUser("host-user", { source: "host-source" }),
    handler,
    requests,
    setReadStatus: (status: number) => (readStatus = status),
    setSessionPolicy: (next: Policy) => (sessionPolicy = next),
    seedDraft: (value: ComposerDraft) => (draft = ComposerDraft.parse(value)),
    beforeNextWrite: (hook: () => Promise<unknown>) => (beforeWrite = hook),
    submitHashes: () =>
      requests
        .filter(({ path }) => path === `${DRAFT_PATH}/submit`)
        .map(({ body }) => boundaryHash(SubmitComposerDraftRequest.parse(body))),
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
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    latencyMode: draft.latencyMode,
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
    expect(f.requests.map(({ method }) => method)).toEqual(["POST"]);
    expect(f.requests[0]!.body).toEqual(submitInput(saved));
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
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT", "POST"]);
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

  for (const replacement of ["queue edit", "native save"] as const) {
    test.each(["send", "steer"] as const)(
      `%s replays the original receipt after different-policy ${replacement}`,
      async (delivery) => {
        const f = fixture();
        const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
        const input = submitInput(saved, { delivery });
        const first = await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, input);
        const replaced = ComposerDraft.parse(
          replacement === "queue edit"
            ? (
                await f.browser.editQueueItem(WORKSPACE_ID, SESSION_ID, QUEUED_TURN_ID, {
                  clientEventId: "edit-another-policy",
                  expectedTurnVersion: 1,
                  expectedDraftRevision: first.draft.revision,
                  replaceDraft: true,
                })
              ).draft
            : await f.actor.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
                ...saveInput(),
                expectedRevision: first.draft.revision,
              }),
        );
        expect(replaced).toMatchObject({ revision: first.draft.revision + 1, ...CLIENT_POLICY });
        const beforeReplay = f.requests.length;
        const replay = await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, input);
        expect(replay).toEqual({ ...first, replay: true });
        expect(replay.receipt.id).toBe(first.receipt.id);
        expect(f.requests.slice(beforeReplay).map(({ method }) => method)).toEqual(["POST"]);
        expect(f.submitHashes()[0]).toBe(f.submitHashes()[1]);
        expect(await f.actor.getComposerDraft(WORKSPACE_ID, SESSION_ID)).toEqual(replaced);
        for (const change of [{ text: "changed" }, { ...CLIENT_POLICY }]) {
          await expect(
            f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, { ...input, ...change }),
          ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
        }
        await expect(
          f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
            ...input,
            clientEventId: "new-key-old-draft",
          }),
        ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
      },
    );
  }

  test.each([
    {},
    { model: null, reasoningEffort: null, latencyMode: null },
    { model: {}, reasoningEffort: 1, latencyMode: "invalid" },
  ])("locked save ignores missing or malformed browser policy: %j", async (policy) => {
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
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  });

  test.each([
    { model: undefined },
    { reasoningEffort: undefined },
    { latencyMode: undefined },
    { model: null },
    { reasoningEffort: null },
    { latencyMode: null },
    { model: "" },
    { reasoningEffort: "invalid" },
    { latencyMode: "invalid" },
    { model: {} },
  ])("submit rejects missing or invalid mandatory policy: %j", async (policy) => {
    const f = fixture();
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
    const beforeSubmit = f.requests.length;
    await expect(
      f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved, policy) as never),
    ).rejects.toMatchObject({ status: 400, code: "invalid_submit" });
    expect(f.requests.slice(beforeSubmit).map(({ method }) => method)).toEqual(["POST"]);
    expect(await f.actor.getComposerDraft(WORKSPACE_ID, SESSION_ID)).toEqual(saved);
  });

  test.each([
    { model: CLIENT_POLICY.model },
    { reasoningEffort: CLIENT_POLICY.reasoningEffort },
    { latencyMode: "priority" },
    { latencyMode: "fast" },
    CLIENT_POLICY,
  ])("submit cannot select new policy against the unchanged saved draft: %j", async (policy) => {
    const f = fixture();
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
    await expect(
      f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved, policy) as never),
    ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
    expect(await f.actor.getComposerDraft(WORKSPACE_ID, SESSION_ID)).toEqual(saved);
    expect(
      (await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved))).replay,
    ).toBe(false);
  });

  test.each(["save", "submit"] as const)("%s revision races fail closed", async (operation) => {
    const f = fixture();
    const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
    f.beforeNextWrite(() =>
      f.actor.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
        ...saveInput(),
        expectedRevision: saved.revision,
      }),
    );
    await expect(
      operation === "save"
        ? f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, {
            ...saveInput(),
            expectedRevision: saved.revision,
          })
        : f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved)),
    ).rejects.toMatchObject({ status: 409, code: "DRAFT_CHANGED" });
    expect(await f.actor.getComposerDraft(WORKSPACE_ID, SESSION_ID)).toMatchObject({
      revision: saved.revision + 1,
      ...CLIENT_POLICY,
    });
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
    "save policy read failure %i fails closed without a write; submit does not look up policy",
    async (status) => {
      const f = fixture();
      const saved = await f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput());
      f.requests.length = 0;
      f.setReadStatus(status);
      await expect(
        f.browser.saveComposerDraft(WORKSPACE_ID, SESSION_ID, saveInput()),
      ).rejects.toMatchObject({ status });
      expect(f.requests.map(({ method }) => method)).toEqual(["GET"]);
      expect(
        (await f.browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, submitInput(saved))).replay,
      ).toBe(false);
      expect(f.requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
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
