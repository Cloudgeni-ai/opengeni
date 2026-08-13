import { createHash } from "node:crypto";
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, withRlsContext, type Database } from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { Permission } from "@opengeni/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";

const tokenPattern = /^ogk_[a-f0-9]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const TURN_INSTRUCTIONS_KEY_PERMISSIONS = [
  "sessions:turn_instructions",
] as const satisfies readonly Permission[];

export type TurnInstructionsKeyProvisionMode = "stage" | "finalize";

export type TurnInstructionsKeyProvisionInput = {
  accountId: string;
  workspaceId: string;
  token: string;
  name: string;
  mode: TurnInstructionsKeyProvisionMode;
};

export type TurnInstructionsKeyProvisionResult = {
  status: "created" | "existing" | "finalized";
  mode: TurnInstructionsKeyProvisionMode;
  accountId: string;
  workspaceId: string;
  apiKeyId: string;
  prefix: string;
  permissions: readonly Permission[];
  revokedPrevious: number;
  activeNamedKeys: number;
};

export function turnInstructionsKeyProvisionInputFromEnv(
  env: NodeJS.ProcessEnv,
): TurnInstructionsKeyProvisionInput {
  const accountId = required(env, "OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID");
  if (!uuidPattern.test(accountId)) {
    throw new Error("OPENGENI_TURN_INSTRUCTIONS_ACCOUNT_ID must be a UUID");
  }
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
  const mode = (env.OPENGENI_TURN_INSTRUCTIONS_KEY_MODE ?? "stage").trim();
  if (mode !== "stage" && mode !== "finalize") {
    throw new Error("OPENGENI_TURN_INSTRUCTIONS_KEY_MODE must be stage or finalize");
  }
  return { accountId, workspaceId, token, name, mode };
}

export async function provisionTurnInstructionsKey(
  db: Database,
  input: TurnInstructionsKeyProvisionInput,
): Promise<TurnInstructionsKeyProvisionResult> {
  const keyHash = createHash("sha256").update(input.token).digest("hex");
  const prefix = input.token.slice(0, 14);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`turn-instructions-key:${input.workspaceId}:${input.name}`}, 0))`,
      );
      const [workspace] = await tx
        .select({ accountId: schema.workspaces.accountId })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, input.workspaceId),
            eq(schema.workspaces.accountId, input.accountId),
          ),
        )
        .limit(1);
      if (!workspace) {
        throw new Error(`Workspace not found for account: ${input.accountId}/${input.workspaceId}`);
      }

      const [matching] = await tx
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.keyHash, keyHash))
        .limit(1);
      const namedKeys = await tx
        .select()
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.workspaceId, input.workspaceId),
            eq(schema.apiKeys.name, input.name),
            isNull(schema.apiKeys.revokedAt),
            sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > now())`,
          ),
        );
      const conflictingNamedKey = namedKeys.find(
        (key) => !samePermissions(key.permissions, TURN_INSTRUCTIONS_KEY_PERMISSIONS),
      );
      if (conflictingNamedKey) {
        throw new Error(
          `Active API key ${conflictingNamedKey.id} uses the dedicated turn-instructions name with conflicting permissions`,
        );
      }

      let selected = matching;
      let status: TurnInstructionsKeyProvisionResult["status"] = "existing";
      if (!selected) {
        if (input.mode === "finalize") {
          throw new Error(
            "Turn-instructions key must be staged before finalization; no matching active key exists",
          );
        }
        [selected] = await tx
          .insert(schema.apiKeys)
          .values({
            accountId: workspace.accountId,
            workspaceId: input.workspaceId,
            name: input.name,
            prefix,
            keyHash,
            permissions: [...TURN_INSTRUCTIONS_KEY_PERMISSIONS],
          })
          .returning();
        if (!selected) throw new Error("Failed to create the turn-instructions API key");
        status = "created";
      }
      const validSelected =
        selected.accountId === workspace.accountId &&
        selected.workspaceId === input.workspaceId &&
        selected.name === input.name &&
        selected.revokedAt === null &&
        (selected.expiresAt === null || selected.expiresAt.getTime() > Date.now()) &&
        samePermissions(selected.permissions, TURN_INSTRUCTIONS_KEY_PERMISSIONS);
      if (!validSelected) {
        throw new Error("The supplied turn-instructions key already exists with conflicting state");
      }

      let revokedPrevious = 0;
      if (input.mode === "finalize") {
        const previous = namedKeys.filter((key) => key.id !== selected.id);
        if (previous.length > 0) {
          const now = new Date();
          const revoked = await tx
            .update(schema.apiKeys)
            .set({ revokedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.apiKeys.workspaceId, input.workspaceId),
                eq(schema.apiKeys.name, input.name),
                isNull(schema.apiKeys.revokedAt),
                sql`${schema.apiKeys.id} <> ${selected.id}`,
              ),
            )
            .returning({ id: schema.apiKeys.id });
          revokedPrevious = revoked.length;
        }
        status = "finalized";
      }

      return {
        status,
        mode: input.mode,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        apiKeyId: selected.id,
        prefix: selected.prefix,
        permissions: TURN_INSTRUCTIONS_KEY_PERMISSIONS,
        revokedPrevious,
        activeNamedKeys: input.mode === "finalize" ? 1 : namedKeys.length + (matching ? 0 : 1),
      };
    },
  );
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
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client = createDb(settings.databaseUrl, {
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
