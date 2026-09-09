import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  authorizeHistoricalSandboxCheckpointRecovery,
  createDb,
  readSandboxLeaseReaperHoldTarget,
} from "@opengeni/db";
import { z } from "zod";

const scopeSchema = z.object({
  accountId: z.uuid(),
  workspaceId: z.uuid(),
  sandboxGroupId: z.uuid(),
});
const authorizationSchema = scopeSchema.extend({
  expectedEpoch: z.number().int().nonnegative(),
  expectedWorkspaceGeneration: z.number().int().nonnegative(),
  expectedArchiveGeneration: z.number().int().nonnegative(),
  selectedRevision: z.string().min(1),
  operationId: z.uuid(),
  subjectId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(2000),
  acceptHistoricalCheckpoint: z.literal(true),
});

async function main(): Promise<void> {
  const [mode, path] = process.argv.slice(2);
  if ((mode !== "preview" && mode !== "authorize") || !path) {
    throw new Error(
      "Usage: bun scripts/operator/historical-checkpoint-recovery.ts preview|authorize <private-input.json>",
    );
  }
  const raw: unknown = await Bun.file(path).json();
  const scope = scopeSchema.parse(raw);
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 1,
  });
  try {
    if (mode === "authorize") {
      const result = await authorizeHistoricalSandboxCheckpointRecovery(
        client.db,
        authorizationSchema.parse(raw),
      );
      console.log(JSON.stringify(result));
      if (!result.authorized) process.exitCode = 2;
      return;
    }
    const lease = await readSandboxLeaseReaperHoldTarget(client.db, scope);
    console.log(
      JSON.stringify(
        lease
          ? {
              ...scope,
              expectedEpoch: lease.leaseEpoch,
              liveness: lease.liveness,
              expectedWorkspaceGeneration: lease.workspaceGeneration,
              expectedArchiveGeneration: lease.archiveGeneration,
              selectedRevision: lease.recovery.archive.current?.revision ?? null,
              restoreStatus: lease.recovery.restore.status,
            }
          : { found: false },
      ),
    );
  } finally {
    await client.close();
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
