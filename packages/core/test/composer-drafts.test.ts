import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  appendSessionEvents,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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
      sandboxBackend: "none",
    });
    const otherSession = await createSession(db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
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
      withWorkspaceSubjectRls(db, workspaceId, grant.subjectId, (scoped) =>
        scoped.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as Database, {
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
      ),
    ).resolves.toMatchObject({ replay: false });
  }, 180_000);
});
