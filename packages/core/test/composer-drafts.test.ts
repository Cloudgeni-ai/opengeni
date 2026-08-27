import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  appendSessionEvents,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { submitComposerDraftForRequest } from "../src/application/composer-submit";
import { saveHumanComposerDraft } from "../src/application/session-commands";
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
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
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
      connectionAuthorities: [],
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
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      submitComposerDraftForRequest(deps, grant, workspaceId, session.id, input, {
        additionalResources: [{ ...hostRepository, ref: "changed" }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  }, 180_000);
});
