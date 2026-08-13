import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bootstrapWorkspace, createDb, withRlsContext, type DbClient } from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  TURN_INSTRUCTIONS_KEY_PERMISSIONS,
  provisionTurnInstructionsKey,
  turnInstructionsKeyProvisionInputFromEnv,
} from "./provision-turn-instructions-key";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const token = `ogk_${"a".repeat(64)}`;
let shared: SharedTestDatabase | null = null;
let runtime: DbClient;
let available = true;

setDefaultTimeout(30_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("operator-turn-instructions-key");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable");
    }
    available = false;
    return;
  }
  runtime = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await runtime?.close();
  await shared?.release();
}, 60_000);

describe("turn-instructions key provision input", () => {
  test("accepts one exact server-only workspace key", () => {
    expect(
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: accountId,
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
      }),
    ).toEqual({
      accountId,
      workspaceId,
      token,
      name: "Embedding host turn instructions",
      mode: "stage",
    });
    expect(TURN_INSTRUCTIONS_KEY_PERMISSIONS).toEqual(["sessions:turn_instructions"]);
  });

  test("rejects malformed workspace, token, and empty key name", () => {
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: "not-an-account",
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID must be a UUID");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: accountId,
        OPENGENI_WORKSPACE_ID: "not-a-workspace",
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
      }),
    ).toThrow("OPENGENI_WORKSPACE_ID must be a UUID");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: accountId,
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: "browser-key",
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_KEY must be an ogk_ token");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: accountId,
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
        OPENGENI_TURN_INSTRUCTIONS_KEY_NAME: "   ",
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_KEY_NAME must contain 1-200 characters");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID: accountId,
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
        OPENGENI_TURN_INSTRUCTIONS_KEY_MODE: "rotate-now",
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_KEY_MODE must be stage or finalize");
  });

  test("stages through FORCE RLS, preserves overlap, and revokes only on explicit finalize", async () => {
    if (!available) return;
    const role = await runtime.db.execute<{
      role: string;
      superuser: boolean;
      bypassRls: boolean;
    }>(
      // The shared harness guarantees this exact role shape; pin it here so a
      // future test fixture cannot silently turn this into a superuser test.
      sql`
        select current_user as role,
          (select rolsuper from pg_roles where rolname = current_user) as superuser,
          (select rolbypassrls from pg_roles where rolname = current_user) as "bypassRls"
      `,
    );
    expect(role[0]).toEqual({ role: "opengeni_app", superuser: false, bypassRls: false });
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(runtime.db, {
      accountExternalSource: "operator-turn-instructions-key",
      accountExternalId: `account-${suffix}`,
      accountName: "Operator turn-instructions key",
      workspaceExternalSource: "operator-turn-instructions-key",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Operator turn-instructions key",
      subjectId: `user:${suffix}`,
    });
    const provisionToken = randomApiKeyToken();
    const provisionInput = {
      accountId: access.defaultAccountId!,
      workspaceId: access.defaultWorkspaceId!,
      token: provisionToken,
      name: "Embedding host turn instructions",
      mode: "stage" as const,
    };

    const created = await provisionTurnInstructionsKey(runtime.db, provisionInput);
    expect(created).toMatchObject({
      status: "created",
      mode: "stage",
      accountId: provisionInput.accountId,
      workspaceId: provisionInput.workspaceId,
      prefix: provisionToken.slice(0, 14),
      permissions: ["sessions:turn_instructions"],
      revokedPrevious: 0,
      activeNamedKeys: 1,
    });

    const replayed = await provisionTurnInstructionsKey(runtime.db, provisionInput);
    expect(replayed).toEqual({ ...created, status: "existing" });

    const rotatedToken = randomApiKeyToken();
    const stagedRotation = await provisionTurnInstructionsKey(runtime.db, {
      ...provisionInput,
      token: rotatedToken,
    });
    expect(stagedRotation).toMatchObject({
      status: "created",
      prefix: rotatedToken.slice(0, 14),
      permissions: ["sessions:turn_instructions"],
      revokedPrevious: 0,
      activeNamedKeys: 2,
    });
    expect(stagedRotation.apiKeyId).not.toBe(created.apiKeyId);

    const stagedKeys = await activeNamedKeys(provisionInput.accountId, provisionInput.workspaceId);
    expect(stagedKeys.map((key) => key.id).sort()).toEqual(
      [created.apiKeyId, stagedRotation.apiKeyId].sort(),
    );

    const finalized = await provisionTurnInstructionsKey(runtime.db, {
      ...provisionInput,
      token: rotatedToken,
      mode: "finalize",
    });
    expect(finalized).toMatchObject({
      status: "finalized",
      mode: "finalize",
      apiKeyId: stagedRotation.apiKeyId,
      revokedPrevious: 1,
      activeNamedKeys: 1,
    });
    expect(await activeNamedKeys(provisionInput.accountId, provisionInput.workspaceId)).toEqual([
      expect.objectContaining({
        id: stagedRotation.apiKeyId,
        permissions: ["sessions:turn_instructions"],
      }),
    ]);

    const finalizedReplay = await provisionTurnInstructionsKey(runtime.db, {
      ...provisionInput,
      token: rotatedToken,
      mode: "finalize",
    });
    expect(finalizedReplay).toMatchObject({
      status: "finalized",
      revokedPrevious: 0,
      activeNamedKeys: 1,
    });
  });
});

async function activeNamedKeys(scopeAccountId: string, scopeWorkspaceId: string) {
  return await withRlsContext(
    runtime.db,
    { accountId: scopeAccountId, workspaceId: scopeWorkspaceId },
    async (db) =>
      await db
        .select({
          id: schema.apiKeys.id,
          permissions: schema.apiKeys.permissions,
          revokedAt: schema.apiKeys.revokedAt,
        })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.workspaceId, scopeWorkspaceId),
            eq(schema.apiKeys.name, "Embedding host turn instructions"),
            isNull(schema.apiKeys.revokedAt),
          ),
        ),
  );
}

function randomApiKeyToken(): string {
  return `ogk_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
