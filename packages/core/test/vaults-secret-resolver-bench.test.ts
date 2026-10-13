// PF-2 (design §13): hosted resolution of 5 references takes at most 50 ms
// p95 against real PostgreSQL. One resolve() call per command, five
// references across two tiers, 500 timed iterations after a warm-up.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseSecretReference, type SecretPrincipal } from "@opengeni/contracts";
import {
  createDb,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createSecretResolver } from "../src/domain/vaults";

setDefaultTimeout(300_000);

const key = new Uint8Array(32).fill(7);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vaults-secret-resolver-bench");
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

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "PF-2: hosted secret resolution latency",
  () => {
    test("5 references resolve in at most 50 ms p95", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vaults-bench-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Bench",
      });
      const grant = access.workspaceGrants[0]!;
      const subjectId = `user:${userId}`;
      const context: VaultDbContext = {
        kind: "subject",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
      };
      const principal: SecretPrincipal = {
        kind: "human",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      };
      const mine = await createVault(db, context, { name: "Mine", ownerKind: "user" });
      const team = await createVault(db, context, { name: "Team", ownerKind: "workspace" });
      const names = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"];
      for (const [index, name] of names.entries()) {
        const value = `bench-${name}-${crypto.randomUUID()}`;
        await upsertVaultItem(db, context, {
          vaultId: index % 2 === 0 ? team.id : mine.id,
          name,
          type: "api_key",
          fields: [
            {
              name: "value",
              kind: "concealed",
              valueEncrypted: encryptEnvironmentValue(Buffer.from(key), value),
              valueSize: Buffer.byteLength(value),
            },
          ],
        });
      }
      const resolver = createSecretResolver({ db, encryptionKey: key }, principal, {
        capabilityEnabled: true,
      });
      const refs = names.map((name) => parseSecretReference(`{{secret:${name}}}`));
      const use = { surface: "shell", toolName: "exec_command" } as const;
      for (let i = 0; i < 20; i += 1) await resolver.resolve(refs, use);
      const samples: number[] = [];
      for (let i = 0; i < 500; i += 1) {
        const started = performance.now();
        const resolved = await resolver.resolve(refs, use);
        samples.push(performance.now() - started);
        if (resolved.size !== refs.length) throw new Error("incomplete resolution");
      }
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length * 0.5)]!;
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      console.log(
        `PF-2 resolve(5 refs) n=500 p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${samples.at(-1)!.toFixed(2)}ms`,
      );
      expect(p95).toBeLessThanOrEqual(50);
    });
  },
);
