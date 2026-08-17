#!/usr/bin/env bun
import {
  bootstrapWorkspace,
  createDb,
  getFiles,
  getFilesForSubject,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { startTestServices } from "@opengeni/testing";

const COUNTS = [1, 8, 32, 128, 512, 1_000] as const;
const SAMPLES = 7;
const services = await startTestServices();
const receipts: Array<Record<string, unknown>> = [];
let client: ReturnType<typeof createDb> | undefined;

try {
  await migrateQuietly();
  client = createDb(services.databaseUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:file-authorization",
    accountExternalId: `account:${suffix}`,
    accountName: "File authorization benchmark",
    workspaceExternalSource: "bench:file-authorization",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "File authorization benchmark",
    subjectId: `user:${suffix}`,
    subjectLabel: "File authorization benchmark",
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");
  const fileIds = Array.from({ length: COUNTS.at(-1)! }, () => crypto.randomUUID());
  for (let offset = 0; offset < fileIds.length; offset += 100) {
    const ids = fileIds.slice(offset, offset + 100);
    await withWorkspaceRls(client.db, grant.workspaceId, async (scopedDb) => {
      await scopedDb.insert(schema.files).values(
        ids.map((id, index) => ({
          id,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          status: "ready" as const,
          filename: `ordinary-${offset + index}.txt`,
          safeFilename: `ordinary-${offset + index}.txt`,
          contentType: "text/plain",
          sizeBytes: 1,
          sha256: "a".repeat(64),
          bucket: "benchmark",
          objectKey: `benchmark/${id}`,
        })),
      );
    });
  }

  for (const count of COUNTS) {
    const ids = fileIds.slice(0, count);
    const workspaceOnlyMs: number[] = [];
    const subjectAuthorizedMs: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const workspaceStartedAt = performance.now();
      const workspaceFiles = await getFiles(client.db, grant.workspaceId, ids);
      workspaceOnlyMs.push(performance.now() - workspaceStartedAt);
      if (workspaceFiles.length !== count) {
        throw new Error(`workspace query returned ${workspaceFiles.length}/${count} files`);
      }

      const subjectStartedAt = performance.now();
      const subjectFiles = await getFilesForSubject(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        fileIds: ids,
      });
      subjectAuthorizedMs.push(performance.now() - subjectStartedAt);
      if (subjectFiles.length !== count) {
        throw new Error(`subject query returned ${subjectFiles.length}/${count} files`);
      }
    }
    receipts.push({
      count,
      samples: SAMPLES,
      workspaceOnlyMs: distribution(workspaceOnlyMs),
      subjectAuthorizedMs: distribution(subjectAuthorizedMs),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        dataShape: "ordinary workspace files with no Google Drive provenance",
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client?.close();
  await services.down();
}

process.exit(0);

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function distribution(values: readonly number[]): {
  min: number;
  p50: number;
  p95: number;
  max: number;
} {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}
