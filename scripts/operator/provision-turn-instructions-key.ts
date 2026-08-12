import { createHash } from "node:crypto";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, type Database } from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { Permission } from "@opengeni/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";

const tokenPattern = /^ogk_[a-f0-9]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const TURN_INSTRUCTIONS_KEY_PERMISSIONS = [
  "sessions:turn_instructions",
] as const satisfies readonly Permission[];

export type TurnInstructionsKeyProvisionInput = {
  workspaceId: string;
  token: string;
  name: string;
};

export type TurnInstructionsKeyProvisionResult = {
  status: "created" | "existing";
  workspaceId: string;
  apiKeyId: string;
  prefix: string;
  permissions: readonly Permission[];
  revokedPrevious: number;
};

export function turnInstructionsKeyProvisionInputFromEnv(
  env: NodeJS.ProcessEnv,
): TurnInstructionsKeyProvisionInput {
  const workspaceId = required(env, "OPENGENI_WORKSPACE_ID");
  if (!uuidPattern.test(workspaceId)) {
    throw new Error("OPENGENI_WORKSPACE_ID must be a UUID");
  }
  const token = required(env, "OPENGENI_TURN_INSTRUCTIONS_KEY");
  if (!tokenPattern.test(token)) {
    throw new Error("OPENGENI_TURN_INSTRUCTIONS_KEY must be an ogk_ token with 64 hex characters");
  }
  const name = (
    env.OPENGENI_TURN_INSTRUCTIONS_KEY_NAME ?? "Embedding host turn instructions"
  ).trim();
  if (name.length === 0 || name.length > 200) {
    throw new Error("OPENGENI_TURN_INSTRUCTIONS_KEY_NAME must contain 1-200 characters");
  }
  return { workspaceId, token, name };
}

export async function provisionTurnInstructionsKey(
  db: Database,
  input: TurnInstructionsKeyProvisionInput,
): Promise<TurnInstructionsKeyProvisionResult> {
  const keyHash = createHash("sha256").update(input.token).digest("hex");
  const prefix = input.token.slice(0, 14);
  return await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`turn-instructions-key:${input.workspaceId}:${input.name}`}, 0))`,
    );
    const [workspace] = await tx
      .select({ accountId: schema.workspaces.accountId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .limit(1);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }

    const [matching] = await tx
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, keyHash))
      .limit(1);
    if (matching) {
      const validExisting =
        matching.accountId === workspace.accountId &&
        matching.workspaceId === input.workspaceId &&
        matching.name === input.name &&
        matching.revokedAt === null &&
        (matching.expiresAt === null || matching.expiresAt.getTime() > Date.now()) &&
        samePermissions(matching.permissions, TURN_INSTRUCTIONS_KEY_PERMISSIONS);
      if (!validExisting) {
        throw new Error("The supplied turn-instructions key already exists with conflicting state");
      }
      return {
        status: "existing",
        workspaceId: input.workspaceId,
        apiKeyId: matching.id,
        prefix: matching.prefix,
        permissions: TURN_INSTRUCTIONS_KEY_PERMISSIONS,
        revokedPrevious: 0,
      };
    }

    const previous = await tx
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.workspaceId, input.workspaceId),
          eq(schema.apiKeys.name, input.name),
          isNull(schema.apiKeys.revokedAt),
        ),
      );
    const now = new Date();
    if (previous.length > 0) {
      await tx
        .update(schema.apiKeys)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.apiKeys.workspaceId, input.workspaceId),
            eq(schema.apiKeys.name, input.name),
            isNull(schema.apiKeys.revokedAt),
          ),
        );
    }
    const [created] = await tx
      .insert(schema.apiKeys)
      .values({
        accountId: workspace.accountId,
        workspaceId: input.workspaceId,
        name: input.name,
        prefix,
        keyHash,
        permissions: [...TURN_INSTRUCTIONS_KEY_PERMISSIONS],
      })
      .returning({ id: schema.apiKeys.id });
    if (!created) throw new Error("Failed to create the turn-instructions API key");
    return {
      status: "created",
      workspaceId: input.workspaceId,
      apiKeyId: created.id,
      prefix,
      permissions: TURN_INSTRUCTIONS_KEY_PERMISSIONS,
      revokedPrevious: previous.length,
    };
  });
}

function samePermissions(actual: readonly string[], expected: readonly Permission[]): boolean {
  return (
    actual.length === expected.length && expected.every((permission) => actual.includes(permission))
  );
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const input = turnInstructionsKeyProvisionInputFromEnv(process.env);
  const databaseUrl = required(process.env, "OPENGENI_MIGRATIONS_DATABASE_URL");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client = createDb(databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 1,
  });
  try {
    const result = await provisionTurnInstructionsKey(client.db, input);
    console.log(JSON.stringify(result));
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  await main();
}
