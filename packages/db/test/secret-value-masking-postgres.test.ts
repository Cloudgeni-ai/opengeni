/**
 * Incident 2 (26 October 2026): a resolved secret value reached the first
 * message of child sessions. Whatever path brings a known value into a
 * message, event or history item, the storage backstop stores its reference.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { SecretValueMemory } from "@opengeni/contracts";
import {
  appendSessionEvents,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionTreeSecretUses,
  recordAuditEvent,
  withSecretValueMasking,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;

// References are assembled so no tool on the way resolves them.
const TOKEN_REF = "\u007B\u007Bsecret:fake-vault/FAKE_GITHUB_TOKEN/value}}";
const FAKE_TOKEN = "ghp_fakeFAKEfake0000000000000000000000";

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("secret-value-masking");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  app = createDb(shared.appUrl, { max: 4 });
}, 900_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 900_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app!.db, {
    accountExternalSource: "secret-mask-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Secret masking",
    workspaceExternalSource: "secret-mask-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Secret masking",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

function newSession(scope: { accountId: string; workspaceId: string }, initialMessage: string) {
  return createSession(app!.db, {
    ...scope,
    initialMessage,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
}

describe("storage backstop for known secret values", () => {
  test("a session started with a resolved value stores the reference (incident 2)", async () => {
    if (!shared || !app) return;
    const scope = await workspace();
    const memory = new SecretValueMemory();
    memory.remember(FAKE_TOKEN, TOKEN_REF);
    const child = await withSecretValueMasking(memory, () =>
      newSession(scope, `Push with GH_TOKEN=${FAKE_TOKEN} and report back.`),
    );
    const [stored] = await shared.admin<Array<{ initialMessage: string }>>`
      select initial_message as "initialMessage" from sessions where id = ${child.id}`;
    expect(stored!.initialMessage).toBe(`Push with GH_TOKEN=${TOKEN_REF} and report back.`);

    // Control: outside an attempt nothing changes.
    const plain = await newSession(scope, `literal ${FAKE_TOKEN}`);
    const [exact] = await shared.admin<Array<{ initialMessage: string }>>`
      select initial_message as "initialMessage" from sessions where id = ${plain.id}`;
    expect(exact!.initialMessage).toBe(`literal ${FAKE_TOKEN}`);
  });

  test("events, turn prompts and history items written by an attempt store references", async () => {
    if (!shared || !app) return;
    const scope = await workspace();
    const session = await newSession(scope, "start");
    const started = await initializeSessionStartAtomically(app.db, {
      ...scope,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("session bootstrap did not create a turn");
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(app.db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`turn not claimable: ${claim.reason}`);
    const turn = claim.turn;
    const memory = new SecretValueMemory();
    memory.remember(FAKE_TOKEN, TOKEN_REF);
    const historyItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `token ${FAKE_TOKEN}` }],
    };
    await withSecretValueMasking(memory, async () => {
      await appendSessionEvents(app!.db, scope.workspaceId, session.id, [
        {
          type: "agent.message.completed",
          payload: { text: `here: ${FAKE_TOKEN}`, json: JSON.stringify({ t: FAKE_TOKEN }) },
          turnId: turn.id,
          turnGeneration: turn.executionGeneration,
          turnAttemptId: attemptId,
        },
      ]);
      const append = () =>
        appendSessionHistoryItems(app!.db, {
          ...scope,
          sessionId: session.id,
          turnId: turn.id,
          expectedExecutionGeneration: turn.executionGeneration,
          expectedAttemptId: attemptId,
          items: [{ position: 1, item: historyItem }],
        });
      expect(await append()).toBeTrue();
      // A retried append compares masked with masked and stays idempotent.
      expect(await append()).toBeTrue();
    });
    const events = await shared.admin<Array<{ payload: string }>>`
      select payload::text as payload from session_events
      where session_id = ${session.id} and type = 'agent.message.completed'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).not.toContain(FAKE_TOKEN);
    expect(events[0]!.payload).toContain("fake-vault/FAKE_GITHUB_TOKEN/value");
    const history = await shared.admin<Array<{ item: string }>>`
      select item_ordered::text as item from session_history_items
      where session_id = ${session.id} and position = 1`;
    expect(history[0]!.item).not.toContain(FAKE_TOKEN);
    expect(history[0]!.item).toContain("fake-vault/FAKE_GITHUB_TOKEN/value");
  });
});

describe("secrets the session tree used before", () => {
  test("lists distinct used fields of the tree and resumes with an overlap", async () => {
    if (!shared || !app) return;
    const scope = await workspace();
    const session = await newSession(scope, "start");
    const other = await newSession(scope, "unrelated");
    const use = (sessionId: string, itemId: string, action = "vault.secret.used") =>
      recordAuditEvent(app!.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        action,
        targetType: "vault_item",
        targetId: itemId,
        metadata: {
          sessionId,
          items: [{ itemId, fieldId: "field-1", fieldName: "value", reference: TOKEN_REF }],
        },
      });
    const itemId = crypto.randomUUID();
    await use(session.id, itemId);
    await use(session.id, itemId);
    await use(other.id, crypto.randomUUID());
    await use(session.id, crypto.randomUUID(), "vault.item.read");

    const first = await listSessionTreeSecretUses(app.db, { ...scope, sessionId: session.id });
    expect(first.uses).toEqual([
      { itemId, fieldId: "field-1", fieldName: "value", reference: TOKEN_REF },
    ]);
    expect(first.latestAt).toBeInstanceOf(Date);
    // The next scan resumes 30 seconds before this one, even with uses found,
    // so a use committed late with an earlier timestamp is still read.
    expect(first.latestAt!.getTime()).toBeLessThanOrEqual(Date.now() - 25_000);

    const next = await listSessionTreeSecretUses(app.db, {
      ...scope,
      sessionId: session.id,
      after: first.latestAt,
    });
    // Uses inside the overlap are read again (callers dedupe them).
    expect(next.uses).toEqual(first.uses);
    expect(next.latestAt).toBeInstanceOf(Date);

    const later = await listSessionTreeSecretUses(app.db, {
      ...scope,
      sessionId: session.id,
      after: new Date(Date.now() + 60_000),
    });
    expect(later.uses).toEqual([]);
  });
});
