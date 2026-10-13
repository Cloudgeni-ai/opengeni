// The vault-backed interaction port against PostgreSQL (0739): agent-owned
// passkeys are saved as vault items, leased to one browser at a time (Q-32),
// sign counts only move forward (D20), and Browser references resolve through
// the real resolver.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type BrowserPasskeyCredentialMaterial,
  parseSecretReference,
  referenceKey,
  type SecretPrincipal,
} from "@opengeni/contracts";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getVaultItem,
  initializeSessionStartAtomically,
  upsertVaultItem,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createVaultInteractionSecretsPort } from "../src/interaction-secrets-vault";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(11);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("interaction-secrets-vault");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function agentAttempt(): Promise<{
  principal: Extract<SecretPrincipal, { kind: "attempt" }>;
  subjectId: string;
}> {
  const db = client!.db;
  const userId = `w4-passkeys-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Passkeys",
  });
  const grant = access.workspaceGrants[0]!;
  const subjectId = `user:${userId}`;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "log in",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    subjectId,
  });
  const started = await initializeSessionStartAtomically(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  return {
    subjectId,
    principal: {
      kind: "attempt",
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
}

const credential: BrowserPasskeyCredentialMaterial = {
  rpId: "localhost",
  credentialId: "Y3JlZGVudGlhbC1pZC0xMjM0NTY",
  userHandle: "dXNlci1oYW5kbGU",
  userName: "alice",
  userDisplayName: "Alice",
  privateKey: "TUlHSEFnRUFNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VIQkcwd2F3SUJBUVFn",
  signCount: 1,
};

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "vault-backed interaction secrets (PostgreSQL)",
  () => {
    test("passkeys: save, lease to one holder, monotonic sign count, release", async () => {
      if (!client) return;
      const db = client.db;
      const { principal } = await agentAttempt();
      const port = createVaultInteractionSecretsPort({ db, encryptionKey: key });
      const store = port.passkeys!;

      const { itemId } = await store.saveRegistered(principal, {
        credential,
        origin: "http://localhost:47423",
      });
      const row = await getVaultItem(db, { kind: "principal", principal }, { itemId });
      expect(row.type).toBe("passkey");
      expect(row.name).toBe("localhost passkey for alice");
      expect(row.websites).toEqual(["http://localhost:47423"]);
      expect(row.fields.map((field) => [field.name, field.kind]).sort()).toEqual(
        [
          ["credentialId", "text"],
          ["privateKey", "concealed"],
          ["rpId", "text"],
          ["userHandle", "text"],
          ["userName", "text"],
        ].sort(),
      );
      expect(Number(row.passkeySignCount)).toBe(1);

      // A second registration for the same user gets a distinct name.
      const second = await store.saveRegistered(principal, {
        credential: { ...credential, credentialId: "c2Vjb25kLWNyZWRlbnRpYWw", signCount: 0 },
        origin: null,
      });
      const secondRow = await getVaultItem(
        db,
        { kind: "principal", principal },
        {
          itemId: second.itemId,
        },
      );
      expect(secondRow.name).toBe("localhost passkey for alice nRpYWw");
      expect(secondRow.websites).toEqual(["https://localhost"]);

      const leased = await store.lease(principal, "browser-a", 600);
      expect(leased.map((entry) => entry.itemId).sort()).toEqual([itemId, second.itemId].sort());
      const first = leased.find((entry) => entry.itemId === itemId)!;
      expect(first).toEqual({ ...credential, userDisplayName: null, itemId });

      // Leased elsewhere: another browser gets nothing until the lease ends.
      expect(await store.lease(principal, "browser-b", 600)).toEqual([]);

      await store.updateSignCount(principal, itemId, 7);
      await store.updateSignCount(principal, itemId, 3);
      const renewed = await store.lease(principal, "browser-a", 600);
      expect(renewed.find((entry) => entry.itemId === itemId)?.signCount).toBe(7);

      await store.release("browser-a");
      const taken = await store.lease(principal, "browser-b", 600);
      expect(taken.map((entry) => entry.itemId).sort()).toEqual([itemId, second.itemId].sort());
      await store.release("browser-b");
    });

    test("references in actions resolve through the real resolver, TOTP included", async () => {
      if (!client) return;
      const db = client.db;
      const { principal, subjectId } = await agentAttempt();
      const context = {
        kind: "subject" as const,
        accountId: principal.accountId,
        workspaceId: principal.workspaceId,
        subjectId,
      };
      const vault = await createVault(db, context, { name: "Logins", ownerKind: "workspace" });
      await upsertVaultItem(db, context, {
        vaultId: vault.id,
        name: "Fake TOTP",
        type: "login",
        fields: [
          ["username", "text", "totp-user"],
          ["password", "concealed", "Fake-Login-Totp-Password-2"],
          ["one-time password", "totp", "JBSWY3DPEHPK3PXP"],
        ].map(([name, kind, value]) => ({
          name: name!,
          kind: kind as "text" | "concealed" | "totp",
          valueEncrypted: encryptEnvironmentValue(Buffer.from(key), value!),
          valueSize: Buffer.byteLength(value!),
        })),
      });
      const port = createVaultInteractionSecretsPort({ db, encryptionKey: key });
      const resolver = await port.resolverFor(principal);
      expect(resolver?.enabled).toBe(true);
      const refs = ["{{secret:Fake TOTP/password}}", "{{secret:Fake TOTP/otp}}"].map((raw) =>
        parseSecretReference(raw),
      );
      const resolved = await resolver!.resolve(refs, {
        surface: "browser",
        toolName: "browser_act",
        operationId: crypto.randomUUID(),
      });
      expect(resolved.get(referenceKey(refs[0]!))?.material).toEqual({
        type: "text",
        value: "Fake-Login-Totp-Password-2",
      });
      expect(resolved.get(referenceKey(refs[1]!))?.material.type).toBe("totp");
    });
  },
);
