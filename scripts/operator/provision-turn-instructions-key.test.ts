import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bootstrapWorkspace, createDb, listApiKeys, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  TURN_INSTRUCTIONS_KEY_PERMISSIONS,
  provisionTurnInstructionsKey,
  turnInstructionsKeyProvisionInputFromEnv,
} from "./provision-turn-instructions-key";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const token = `ogk_${"a".repeat(64)}`;
let shared: SharedTestDatabase | null = null;
let runtime: DbClient;
let owner: DbClient;
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
  owner = createDb(shared.adminUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await runtime?.close();
  await owner?.close();
  await shared?.release();
}, 60_000);

describe("turn-instructions key provision input", () => {
  test("accepts one exact server-only workspace key", () => {
    expect(
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
      }),
    ).toEqual({
      workspaceId,
      token,
      name: "Embedding host turn instructions",
    });
    expect(TURN_INSTRUCTIONS_KEY_PERMISSIONS).toEqual(["sessions:turn_instructions"]);
  });

  test("rejects malformed workspace, token, and empty key name", () => {
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_WORKSPACE_ID: "not-a-workspace",
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
      }),
    ).toThrow("OPENGENI_WORKSPACE_ID must be a UUID");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: "browser-key",
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_KEY must be an ogk_ token");
    expect(() =>
      turnInstructionsKeyProvisionInputFromEnv({
        OPENGENI_WORKSPACE_ID: workspaceId,
        OPENGENI_TURN_INSTRUCTIONS_KEY: token,
        OPENGENI_TURN_INSTRUCTIONS_KEY_NAME: "   ",
      }),
    ).toThrow("OPENGENI_TURN_INSTRUCTIONS_KEY_NAME must contain 1-200 characters");
  });

  test("provisions idempotently and revokes the prior named key on rotation", async () => {
    if (!available) return;
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
      workspaceId: access.defaultWorkspaceId!,
      token: provisionToken,
      name: "Embedding host turn instructions",
    };

    const created = await provisionTurnInstructionsKey(owner.db, provisionInput);
    expect(created).toMatchObject({
      status: "created",
      workspaceId: provisionInput.workspaceId,
      prefix: provisionToken.slice(0, 14),
      permissions: ["sessions:turn_instructions"],
      revokedPrevious: 0,
    });

    const replayed = await provisionTurnInstructionsKey(owner.db, provisionInput);
    expect(replayed).toEqual({ ...created, status: "existing" });

    const rotatedToken = randomApiKeyToken();
    const rotated = await provisionTurnInstructionsKey(owner.db, {
      ...provisionInput,
      token: rotatedToken,
    });
    expect(rotated).toMatchObject({
      status: "created",
      prefix: rotatedToken.slice(0, 14),
      permissions: ["sessions:turn_instructions"],
      revokedPrevious: 1,
    });
    expect(rotated.apiKeyId).not.toBe(created.apiKeyId);

    const keys = await listApiKeys(runtime.db, provisionInput.workspaceId);
    expect(keys).toHaveLength(2);
    expect(keys.filter((key) => key.revokedAt === null)).toEqual([
      expect.objectContaining({
        id: rotated.apiKeyId,
        permissions: ["sessions:turn_instructions"],
      }),
    ]);
    expect(keys.find((key) => key.id === created.apiKeyId)?.revokedAt).not.toBeNull();
  });
});

function randomApiKeyToken(): string {
  return `ogk_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
