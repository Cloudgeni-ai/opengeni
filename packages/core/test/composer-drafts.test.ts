import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as draftPreparation from "../src/application/draft-model-preparation";
import type { ResourceRef } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  appendSessionEvents,
  createDb,
  createSession,
  SessionCommandIdempotencyError,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { submitComposerDraftForRequest } from "../src/application/composer-submit";
import { getHumanComposerDraft, saveHumanComposerDraft } from "../src/application/session-commands";
import { setSessionModel } from "../src/domain/sessions";
import { normalizeResources } from "../src/domain/resources";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-composer-drafts");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("established-session composer drafts", () => {
  test("only a committed composer revision schedules preparation", async () => {
    if (!available) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "Draft preparation",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "Draft preparation",
      subjectId: `draft-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const settings = testSettings();
    const session = await createSession(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const context = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      subjectId: grant.subjectId,
    };
    const input = {
      expectedRevision: 0,
      text: "Not sent",
      resources: [],
      model: settings.openaiModel,
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
    };
    const prepare = spyOn(draftPreparation, "prepareDraftModel").mockImplementation(() => {});
    try {
      const saved = await saveHumanComposerDraft({ db, settings }, context, input);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith({ db, settings }, context, saved);
      await expect(saveHumanComposerDraft({ db, settings }, context, input)).rejects.toThrow();
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      prepare.mockRestore();
    }
  }, 180_000);

  test("validates annotation quotes against canonical same-session events", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `annotation-account-${suffix}`,
      accountName: "Timeline annotation drafts",
      workspaceExternalSource: "test",
      workspaceExternalId: `annotation-workspace-${suffix}`,
      workspaceName: "Timeline annotation drafts",
      subjectId: `annotation-subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const sourceSession = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const otherSession = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const [sourceEvent] = await appendSessionEvents(db, workspaceId, sourceSession.id, [
      {
        type: "agent.message.completed",
        payload: { text: "alpha beta omega" },
      },
    ]);
    const [ambiguousSourceEvent] = await appendSessionEvents(db, workspaceId, sourceSession.id, [
      {
        type: "agent.message.completed",
        payload: { text: "aaa" },
      },
    ]);
    const annotation = {
      id: crypto.randomUUID(),
      source: {
        kind: "assistant_message" as const,
        eventId: sourceEvent!.id,
        eventType: "agent.message.completed" as const,
        sequence: sourceEvent!.sequence,
        turnId: null,
        // Stale client offsets are recoverable when the exact quote is unique.
        startOffset: 0,
        endOffset: 4,
        contextBefore: "",
        contextAfter: "",
      },
      quote: "beta",
      note: "",
    };

    const saved = await saveHumanComposerDraft(
      { db },
      {
        accountId: grant.accountId,
        workspaceId,
        sessionId: sourceSession.id,
        subjectId: grant.subjectId,
      },
      {
        expectedRevision: 0,
        text: "",
        annotations: [annotation],
        resources: [],
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
    );
    expect(saved.annotations).toMatchObject([
      {
        quote: "beta",
        source: {
          startOffset: 6,
          endOffset: 10,
          contextBefore: "alpha ",
          contextAfter: " omega",
        },
      },
    ]);

    await expect(
      saveHumanComposerDraft(
        { db },
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId: sourceSession.id,
          subjectId: grant.subjectId,
        },
        {
          expectedRevision: saved.revision,
          text: "",
          annotations: [
            {
              id: crypto.randomUUID(),
              source: {
                kind: "assistant_message",
                eventId: ambiguousSourceEvent!.id,
                eventType: "agent.message.completed",
                sequence: ambiguousSourceEvent!.sequence,
                turnId: null,
                startOffset: 5,
                endOffset: 7,
                contextBefore: "",
                contextAfter: "",
              },
              quote: "aa",
              note: "",
            },
          ],
          resources: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          latencyMode: "standard",
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      saveHumanComposerDraft(
        { db },
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId: otherSession.id,
          subjectId: grant.subjectId,
        },
        {
          expectedRevision: 0,
          text: "",
          annotations: [annotation],
          resources: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          latencyMode: "standard",
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 180_000);

  test("normalizes repository resources before the Send content fence", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Composer draft normalization",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Composer draft normalization",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const resources: ResourceRef[] = [
      {
        kind: "repository",
        uri: "https://cloudgeni@dev.azure.com/cloudgeni/cloudgeni-bicep-demo/_git/cloudgeni-bicep-demo",
        ref: " main ",
        mountPath: "repositories/cloudgeni-bicep-demo",
        provider: "azure_devops",
        connectionId: "azure-devops-cloudgeni",
        access: "write",
      },
    ];
    const canonicalResources = normalizeResources(resources);

    const saved = await saveHumanComposerDraft(
      { db },
      {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
      },
      {
        expectedRevision: 0,
        text: "use the repository",
        resources,
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
    );

    expect(saved.resources).toEqual(canonicalResources);
    await expect(
      withWorkspaceSubjectSessionActivityRls(db, workspaceId, grant.subjectId, (scoped) =>
        submitHumanPromptInTransaction(scoped, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          expectedDraftRevision: saved.revision,
          text: saved.text,
          resources: canonicalResources,
          model: saved.model,
          reasoningEffort: saved.reasoningEffort,
          latencyMode: saved.latencyMode,
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
    ).resolves.toMatchObject({ replay: false });
  }, 180_000);

  test("accepts, rotates, and replays one composer command through the public application seam", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `submit-account-${suffix}`,
      accountName: "Composer application submit",
      workspaceExternalSource: "test",
      workspaceExternalId: `submit-workspace-${suffix}`,
      workspaceName: "Composer application submit",
      subjectId: `submit-subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "previous-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const saved = await saveHumanComposerDraft(
      { db },
      {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
      },
      {
        expectedRevision: 0,
        text: "accept this exact draft",
        annotations: [],
        resources: [],
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
    );
    const clientEventId = crypto.randomUUID();
    const hostRepository: ResourceRef = {
      kind: "repository",
      uri: "https://dev.azure.com/example/project/_git/repository",
      ref: "main",
      mountPath: "repositories/host-authorized",
      provider: "azure_devops",
      repositoryId: "host-authorized",
      connectionId: "connection-host-authorized",
      access: "write",
    };
    const input = {
      clientEventId,
      expectedDraftRevision: saved.revision,
      delivery: "send" as const,
      text: saved.text,
      annotations: saved.annotations,
      resources: saved.resources,
      model: saved.model,
      reasoningEffort: saved.reasoningEffort,
      latencyMode: saved.latencyMode,
      connectionAccounts: [],
    };
    const deps = {
      settings: testSettings({ sandboxBackend: "none" }),
      db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => undefined },
      objectStorage: null,
    } as unknown as Parameters<typeof submitComposerDraftForRequest>[0];

    const accepted = await submitComposerDraftForRequest(
      deps,
      grant,
      workspaceId,
      session.id,
      input,
      { additionalResources: [hostRepository] },
    );
    expect(accepted).toMatchObject({
      replay: false,
      accepted: { clientEventId },
      draft: {
        revision: saved.revision + 1,
        text: "",
        resources: [],
        sourceTurnId: null,
        sourceTurnVersion: null,
      },
      receipt: { operationKey: clientEventId },
      turn: { resources: [hostRepository] },
    });
    const [stored] = await shared!.admin`
      select model, reasoning_effort as "reasoningEffort" from sessions where id = ${session.id}`;
    expect(stored).toEqual({ model: saved.model, reasoningEffort: saved.reasoningEffort });

    const replay = await submitComposerDraftForRequest(
      deps,
      grant,
      workspaceId,
      session.id,
      input,
      { additionalResources: [hostRepository] },
    );
    expect(replay).toMatchObject({
      replay: true,
      accepted: { id: accepted.accepted.id, clientEventId },
      turn: { id: accepted.turn.id },
      receipt: { id: accepted.receipt.id, operationKey: clientEventId },
      draft: accepted.draft,
    });

    await expect(
      submitComposerDraftForRequest(
        deps,
        grant,
        workspaceId,
        session.id,
        {
          ...input,
          text: "changed after acceptance",
        },
        { additionalResources: [hostRepository] },
      ),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);

    await expect(
      submitComposerDraftForRequest(deps, grant, workspaceId, session.id, input, {
        additionalResources: [{ ...hostRepository, ref: "changed" }],
      }),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  }, 180_000);

  test("a draft that follows the chat shows and runs on a model switched elsewhere", async () => {
    if (!available) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `follow-account-${suffix}`,
      accountName: "Composer follows the chat",
      workspaceExternalSource: "test",
      workspaceExternalId: `follow-workspace-${suffix}`,
      workspaceName: "Composer follows the chat",
      subjectId: `user:follow-${suffix}`,
    });
    const grant = {
      ...access.workspaceGrants[0]!,
      principalKind: "human_session" as const,
      permissions: ["sessions:read" as const, "sessions:control" as const],
    };
    const workspaceId = grant.workspaceId!;
    const session = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const context = {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    };
    const deps = {
      settings: testSettings({ sandboxBackend: "none" }),
      db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => undefined },
      objectStorage: null,
    } as unknown as Parameters<typeof submitComposerDraftForRequest>[0] &
      Parameters<typeof setSessionModel>[0];
    const turnModel = async (turnId: string) =>
      (
        await shared!.admin`
          select model, reasoning_effort as "reasoningEffort" from session_turns where id = ${turnId}`
      )[0];
    const sessionPolicy = async () =>
      (
        await shared!.admin`
          select model, reasoning_effort as "reasoningEffort" from sessions where id = ${session.id}`
      )[0];

    // A fresh composer follows the chat.
    const fresh = await getHumanComposerDraft({ db }, context);
    expect(fresh).toMatchObject({ revision: 0, model: "gpt-5.6-sol", modelProvided: false });
    const typed = await saveHumanComposerDraft({ db }, context, {
      expectedRevision: 0,
      text: "use the cheaper one now",
      annotations: [],
      resources: [],
      model: fresh.model,
      reasoningEffort: fresh.reasoningEffort,
      latencyMode: fresh.latencyMode,
      modelProvided: false,
    });
    expect(typed).toMatchObject({ revision: 1, modelProvided: false });

    // The chat switches elsewhere (the agent's tool runs the same command).
    const switched = await setSessionModel(deps, grant, session.id, {
      model: "scripted-model",
      reasoningEffort: "high",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(switched).toMatchObject({ model: "scripted-model", reasoningEffort: "high" });

    // The composer now shows the switch without a new draft revision.
    const shown = await getHumanComposerDraft({ db }, context);
    expect(shown).toMatchObject({
      revision: 1,
      text: "use the cheaper one now",
      model: "scripted-model",
      reasoningEffort: "high",
      modelProvided: false,
    });

    // Even a client still holding the old policy runs on the chat's model and
    // leaves the switch in place.
    const followed = await submitComposerDraftForRequest(deps, grant, workspaceId, session.id, {
      clientEventId: crypto.randomUUID(),
      expectedDraftRevision: typed.revision,
      delivery: "send",
      text: typed.text,
      annotations: [],
      resources: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      modelProvided: false,
      connectionAccounts: [],
    });
    expect(await turnModel(followed.turn.id)).toEqual({
      model: "scripted-model",
      reasoningEffort: "high",
    });
    expect(await sessionPolicy()).toEqual({ model: "scripted-model", reasoningEffort: "high" });
    expect(followed.draft).toMatchObject({
      revision: typed.revision + 1,
      model: "scripted-model",
      reasoningEffort: "high",
      modelProvided: false,
    });

    // A model the person picks in the composer still wins, and then becomes
    // the policy the next draft follows.
    const picked = await saveHumanComposerDraft({ db }, context, {
      expectedRevision: followed.draft.revision,
      text: "back to the other one",
      annotations: [],
      resources: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "standard",
      modelProvided: true,
    });
    expect(picked).toMatchObject({ model: "gpt-5.6-sol", modelProvided: true });
    const sent = await submitComposerDraftForRequest(deps, grant, workspaceId, session.id, {
      clientEventId: crypto.randomUUID(),
      expectedDraftRevision: picked.revision,
      delivery: "send",
      text: picked.text,
      annotations: [],
      resources: [],
      model: picked.model,
      reasoningEffort: picked.reasoningEffort,
      latencyMode: picked.latencyMode,
      modelProvided: true,
      connectionAccounts: [],
    });
    expect(await turnModel(sent.turn.id)).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "low" });
    expect(await sessionPolicy()).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "low" });
    expect(sent.draft).toMatchObject({ model: "gpt-5.6-sol", modelProvided: false });

    // A save from an older client, without the flag, is a pick as before.
    const legacy = await saveHumanComposerDraft({ db }, context, {
      expectedRevision: sent.draft.revision,
      text: "",
      annotations: [],
      resources: [],
      model: "scripted-model",
      reasoningEffort: "high",
      latencyMode: "standard",
    });
    expect(legacy).toMatchObject({ model: "scripted-model", modelProvided: true });
  }, 180_000);
});
