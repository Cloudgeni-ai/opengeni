import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  canonicalSessionCommandHash,
  createDb,
  createSession,
  createSessionMcpServers,
  encryptVariableSetValue,
  replayHumanPromptInTransaction,
  SessionCommandIdempotencyError,
  sessionPromptPayloadIdentity,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type SessionCommandActor,
  type SessionPromptReplayCredentialUpdate,
} from "../src/index";
import * as schema from "../src/schema";
import { and, eq } from "drizzle-orm";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-prompt-replay");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(withCredentialServer = false) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Prompt replay",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Prompt replay",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const encryptionKey = randomBytes(32);
  if (withCredentialServer) {
    await createSessionMcpServers(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      servers: [
        {
          id: "private",
          url: "https://mcp.example.test",
          headersEncrypted: {
            Authorization: encryptVariableSetValue(encryptionKey, "before"),
          },
        },
      ],
    });
  }
  const actor: SessionCommandActor = {
    type: "human",
    subjectId: grant.subjectId,
  };
  return { grant, session, actor, encryptionKey };
}

function promptInput(
  value: Awaited<ReturnType<typeof fixture>>,
  operationKey: string,
  text = "accepted prompt",
  credentials: SessionPromptReplayCredentialUpdate[] = [],
) {
  const payload = {
    delivery: "send" as const,
    text,
    resources: [],
    tools: [],
    toolsProvided: false,
    source: "user" as const,
    credentialUpdates: credentials,
  };
  return {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId!,
    sessionId: value.session.id,
    subjectId: value.grant.subjectId,
    actor: value.actor,
    operationKey,
    delivery: payload.delivery,
    text: payload.text,
    resources: payload.resources,
    tools: payload.tools,
    toolsProvided: payload.toolsProvided,
    reasoningEffortFallback: "medium" as const,
    source: payload.source,
    promptPayloadIdentity: sessionPromptPayloadIdentity(payload),
    replayCredentialUpdates: credentials,
    credentialEncryptionKey: credentials.length > 0 ? value.encryptionKey : null,
    mcpCredentialUpdates: credentials.map((update) => ({
      id: update.id,
      headersEncrypted: Object.fromEntries(
        Object.entries(update.headers).map(([name, headerValue]) => [
          name,
          encryptVariableSetValue(value.encryptionKey, headerValue),
        ]),
      ),
    })),
  };
}

async function submit(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Parameters<typeof submitHumanPromptInTransaction>[1],
) {
  return await withWorkspaceSubjectRls(
    client.db,
    value.grant.workspaceId!,
    value.grant.subjectId,
    (db) => db.transaction((tx) => submitHumanPromptInTransaction(tx as typeof db, input)),
  );
}

async function replay(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Parameters<typeof replayHumanPromptInTransaction>[1],
) {
  return await withWorkspaceSubjectRls(
    client.db,
    value.grant.workspaceId!,
    value.grant.subjectId,
    (db) => db.transaction((tx) => replayHumanPromptInTransaction(tx as typeof db, input)),
  );
}

describe("durable prompt Send replay", () => {
  test("returns only the exact applied turn and keeps action/new-key admission separate", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const input = promptInput(value, operationKey);
    const accepted = await submit(value, input);

    await expect(replay(value, input)).resolves.toMatchObject({
      replay: true,
      turnId: accepted.turnId,
      acceptedEventId: accepted.acceptedEventId,
      wakeRevision: accepted.wakeRevision,
    });
    await expect(
      replay(value, promptInput(value, operationKey, "changed prompt")),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
    await expect(replay(value, promptInput(value, crypto.randomUUID()))).resolves.toBeNull();
    const { promptPayloadIdentity: _identity, ...withoutIdentity } = input;
    await expect(replay(value, { ...withoutIdentity, delivery: "steer" })).resolves.toBeNull();
  });

  test("fails closed for a pending or incomplete durable receipt", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const input = promptInput(value, operationKey);
    await withWorkspaceSubjectRls(
      client.db,
      value.grant.workspaceId!,
      value.grant.subjectId,
      (db) =>
        db.insert(schema.sessionCommandReceipts).values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          actorType: "human",
          actorSubjectId: value.grant.subjectId,
          action: "prompt.send",
          targetSessionId: value.session.id,
          operationKey,
          canonicalRequestHash: canonicalSessionCommandHash({
            text: input.text,
          }),
          result: { promptPayloadIdentity: input.promptPayloadIdentity },
        }),
    );

    await expect(replay(value, input)).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("fails closed when the original durable workflow wake fact is missing", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const input = promptInput(value, operationKey);
    await submit(value, input);
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .delete(schema.sessionWorkflowWakeOutbox)
        .where(
          and(
            eq(schema.sessionWorkflowWakeOutbox.workspaceId, value.grant.workspaceId!),
            eq(schema.sessionWorkflowWakeOutbox.sessionId, value.session.id),
          ),
        ),
    );

    await expect(replay(value, input)).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("fails closed instead of filtering malformed completed receipt facts", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const input = promptInput(value, operationKey);
    const accepted = await submit(value, input);
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .update(schema.sessionCommandReceipts)
        .set({
          result: {
            ...accepted.receipt.result,
            eventIds: [...accepted.eventIds, 42],
          },
        })
        .where(eq(schema.sessionCommandReceipts.id, accepted.receipt.id)),
    );

    await expect(replay(value, input)).rejects.toThrow(
      "The prior operation was accepted but its durable result cannot be safely replayed",
    );
  });

  test("fails closed for noncanonical completed credential metadata", async () => {
    const value = await fixture(true);
    const operationKey = crypto.randomUUID();
    const credentials = [
      {
        id: "private",
        headers: { Authorization: "accepted", "X-Session": "secondary" },
      },
    ];
    const input = promptInput(value, operationKey, "credential prompt", credentials);
    const accepted = await submit(value, input);
    const appliedUpdates = accepted.receipt.result.credentialUpdateShape as Array<{
      id: string;
      headerNames: string[];
      credentialVersion: number;
    }>;
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .update(schema.sessionCommandReceipts)
        .set({
          result: {
            ...accepted.receipt.result,
            credentialUpdateShape: appliedUpdates.map((update) => ({
              ...update,
              headerNames: [...update.headerNames].reverse(),
            })),
          },
        })
        .where(eq(schema.sessionCommandReceipts.id, accepted.receipt.id)),
    );

    await expect(replay(value, input)).rejects.toThrow(
      "The prior operation was accepted but its durable result cannot be safely replayed",
    );
  });

  test("serializes concurrent exact retries despite randomized credential ciphertext", async () => {
    const value = await fixture(true);
    const operationKey = crypto.randomUUID();
    const credentials = [{ id: "private", headers: { Authorization: "accepted" } }];
    const [left, right] = await Promise.all([
      submit(value, promptInput(value, operationKey, "credential prompt", credentials)),
      submit(value, promptInput(value, operationKey, "credential prompt", credentials)),
    ]);

    expect(new Set([left.turnId, right.turnId]).size).toBe(1);
    expect([left.replay, right.replay].filter(Boolean)).toHaveLength(1);
    await expect(
      replay(
        value,
        promptInput(value, operationKey, "credential prompt", [
          { id: "private", headers: { Authorization: "changed" } },
        ]),
      ),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("does not confuse a later credential rotation with the original accepted input", async () => {
    const value = await fixture(true);
    const operationKey = crypto.randomUUID();
    await submit(
      value,
      promptInput(value, operationKey, "credential prompt", [
        { id: "private", headers: { Authorization: "original" } },
      ]),
    );
    await submit(
      value,
      promptInput(value, crypto.randomUUID(), "rotate credential", [
        { id: "private", headers: { Authorization: "rotated" } },
      ]),
    );

    // Credential values are intentionally absent from the persisted identity.
    // The original receipt's applied credential version must still prevent the
    // current rotated value from masquerading as the original retry payload.
    await expect(
      replay(
        value,
        promptInput(value, operationKey, "credential prompt", [
          { id: "private", headers: { Authorization: "rotated" } },
        ]),
      ),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("reconstructs a legacy credential hash only after plaintext comparison", async () => {
    const value = await fixture(true);
    const operationKey = crypto.randomUUID();
    const credentials = [{ id: "private", headers: { Authorization: "legacy" } }];
    const input = promptInput(value, operationKey, "legacy prompt", credentials);
    const { promptPayloadIdentity: _identity, ...legacyInput } = input;
    const accepted = await submit(value, legacyInput);

    await expect(replay(value, input)).resolves.toMatchObject({
      replay: true,
      turnId: accepted.turnId,
    });
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .update(schema.sessionMcpServers)
        .set({
          headersEncrypted: {
            Authorization: encryptVariableSetValue(value.encryptionKey, "legacy"),
          },
        })
        .where(
          and(
            eq(schema.sessionMcpServers.workspaceId, value.grant.workspaceId!),
            eq(schema.sessionMcpServers.sessionId, value.session.id),
            eq(schema.sessionMcpServers.serverId, "private"),
          ),
        ),
    );
    await expect(replay(value, input)).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });
});
