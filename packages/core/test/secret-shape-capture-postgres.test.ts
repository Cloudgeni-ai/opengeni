/**
 * Incident 1 (26 October 2026): kubectl output printed a database URL with
 * its password, and it was stored and sent to the model as written. A
 * secret-shaped value in tool output is now saved into the run's task vault
 * and replaced by its reference, which a later command can use whole.
 * Every value here is fake.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  findSecretReferences,
  replaceReferencesDeep,
  referenceKey,
  SecretValueMemory,
  type SecretPrincipal,
} from "@opengeni/contracts";
import {
  appendSessionHistoryItems,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  initializeSessionStartAtomically,
  withSecretValueMasking,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createSecretResolver,
  createTaskVaultSecretCapturer,
  createVaultService,
  isSecretShapeItemName,
  secretShapeItemName,
} from "../src/domain/vaults";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(21);
const FAKE_PASSWORD = "FAKE-pw-0000-not-real";
const DATABASE_URL = `postgres://user:${FAKE_PASSWORD}@host:5432/db?sslmode=require`;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("secret-shape-capture");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 900_000);

async function attemptOfNewChat() {
  const db = client!.db;
  const userId = `secret-shape-capture-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Capture",
  });
  const grant = access.workspaceGrants[0]!;
  const subjectId = `user:${userId}`;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const session = await createSession(db, {
    ...scope,
    initialMessage: "list the runtime secret",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject" as const, subjectId },
    subjectId,
  });
  const started = await initializeSessionStartAtomically(db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const principal = {
    kind: "attempt",
    ...scope,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  } satisfies SecretPrincipal;
  return { db, scope, session, principal, turn: claimed.turn, attemptId };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "secret-shaped values in tool output (PostgreSQL)",
  () => {
    test("incident 1: masked when shown and stored, kept in the task vault, usable by reference", async () => {
      if (!client) return;
      const { db, scope, session, principal, turn, attemptId } = await attemptOfNewChat();
      const failures: string[] = [];
      const memory = new SecretValueMemory();
      memory.setShapeCapturer(
        createTaskVaultSecretCapturer({
          db,
          encryptionKey: key,
          principal,
          onFailure: (failure) => failures.push(`${failure.kind}:${failure.error}`),
        }),
      );
      // kubectl get secret … | jq: the keys matching BASE_URL, values decoded.
      const output = [
        "OPENGENI_API_BASE_URL=https://api.example.test",
        `OPENGENI_DATABASE_URL=${DATABASE_URL}`,
        "",
      ].join("\n");

      await memory.captureShapes(output);
      const shown = memory.maskToolOutput(output);
      expect(failures).toEqual([]);
      expect(shown).not.toContain(FAKE_PASSWORD);
      expect(shown).toContain("OPENGENI_API_BASE_URL=https://api.example.test\n");
      const references = findSecretReferences(shown);
      expect(references).toHaveLength(1);
      const itemName = secretShapeItemName("url-password", FAKE_PASSWORD, key);
      expect(itemName).toMatch(/^url-password-[0-9a-f]{16}$/);
      expect(references[0]!.raw).toBe(
        ["\u007B\u007Bsecret", `Task/${itemName}/password}}`].join(":"),
      );
      expect(shown).toBe(output.replace(FAKE_PASSWORD, references[0]!.raw));

      // The stored copy (history written during the attempt) never has the value,
      // even when the raw text reaches the writer by another path.
      await withSecretValueMasking(memory, () =>
        appendSessionHistoryItems(db, {
          ...scope,
          sessionId: session.id,
          turnId: turn.id,
          expectedExecutionGeneration: turn.executionGeneration,
          expectedAttemptId: attemptId,
          items: [
            {
              position: 1,
              item: {
                type: "function_call_result",
                callId: "call-kubectl",
                name: "exec_command",
                status: "completed",
                output: { type: "text", text: output },
              },
            },
          ],
        }),
      );
      const stored = JSON.stringify(
        await shared!.admin<Array<{ item: string }>>`
          select item_ordered::text as item from session_history_items
          where session_id = ${session.id}`,
      );
      expect(stored).not.toContain(FAKE_PASSWORD);
      expect(stored).toContain(`Task/${itemName}/password`);

      // A later command uses the masked URL whole; the reference resolves to
      // the value, so the command gets the original URL.
      const command = `psql "${shown.split("\n")[1]!.slice("OPENGENI_DATABASE_URL=".length)}" -c 'select 1'`;
      const resolver = createSecretResolver({ db, encryptionKey: key }, principal, {
        capabilityEnabled: true,
      });
      const resolved = await resolver.resolve(findSecretReferences(command), {
        surface: "shell",
        toolName: "exec_command",
      });
      const values = new Map(
        [...resolved.values()].map((value) => [
          referenceKey(value.reference),
          value.material.type === "text" ? value.material.value : "",
        ]),
      );
      expect(replaceReferencesDeep(command, (ref) => values.get(referenceKey(ref)) ?? "")).toBe(
        `psql "${DATABASE_URL}" -c 'select 1'`,
      );

      // Found again (another call, another attempt): the same item, not a new one.
      const again = new SecretValueMemory();
      again.setShapeCapturer(createTaskVaultSecretCapturer({ db, encryptionKey: key, principal }));
      await again.captureShapes(output);
      expect(again.maskToolOutput(output)).toBe(shown);
      const items = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count from vault_items item
        join vaults vault on vault.id = item.vault_id
        where vault.workspace_id = ${scope.workspaceId}::uuid and vault.owner_kind = 'task'`;
      expect(items[0]!.count).toBe(1);
      // Saved like any secret write: audited with metadata only.
      const audits = await shared!.admin<{ metadata: unknown }[]>`
        select metadata from audit_events
        where workspace_id = ${scope.workspaceId}::uuid and action like 'vault.item.%'`;
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain(FAKE_PASSWORD);
    });

    test("an item holding another value is not reused, and a full task vault gets markers", async () => {
      if (!client) return;
      const { db, principal } = await attemptOfNewChat();
      const service = createVaultService({ db, encryptionKey: key });
      const capture = (value: string, createAllowed?: boolean) =>
        service.captureForAgent(principal, {
          item: secretShapeItemName("url-password", FAKE_PASSWORD, key),
          type: "login",
          field: "password",
          value,
          ...(createAllowed === undefined ? {} : { createAllowed }),
        });
      expect((await capture(FAKE_PASSWORD)).created).toBe(true);
      expect((await capture(FAKE_PASSWORD, false)).created).toBe(false);
      // Same name, different value (the item was edited since): no reference.
      await expect(capture(`${FAKE_PASSWORD}-edited`)).rejects.toMatchObject({
        code: "vault_item_name_conflict",
      });
      expect(await service.countTaskVaultItemsForAgent(principal, isSecretShapeItemName, 200)).toBe(
        1,
      );
      await expect(
        service.captureForAgent(principal, {
          item: secretShapeItemName("github-token", "ghp_FAKE0", key),
          type: "api_key",
          field: "value",
          value: "ghp_FAKE0",
          createAllowed: false,
        }),
      ).rejects.toMatchObject({ code: "vault_limit_reached" });
    });
  },
);
