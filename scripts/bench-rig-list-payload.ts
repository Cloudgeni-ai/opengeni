#!/usr/bin/env bun
import {
  bootstrapWorkspace,
  createDb,
  listRigSummaries,
  listRigs,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { startTestServices } from "@opengeni/testing";
import { gzipSync } from "node:zlib";

const COUNTS = [1, 10, 50] as const;
const SAMPLES = 5;
const MAX_SETUP = buildMaxSetup();
const services = await startTestServices();
let client: ReturnType<typeof createDb> | undefined;

try {
  await migrateQuietly();
  client = createDb(services.databaseUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:rig-list-payload",
    accountExternalId: `account:${suffix}`,
    accountName: "Rig list payload benchmark",
    workspaceExternalSource: "bench:rig-list-payload",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Rig list payload benchmark",
    subjectId: `user:${suffix}`,
    subjectLabel: "Rig list payload benchmark",
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");
  const receipts: Array<Record<string, unknown>> = [];
  let seeded = 0;

  for (const count of COUNTS) {
    const additions = Array.from({ length: count - seeded }, (_, offset) => {
      const index = seeded + offset;
      return { index, rigId: crypto.randomUUID(), versionId: crypto.randomUUID() };
    });
    await withWorkspaceRls(client.db, grant.workspaceId, async (scopedDb) => {
      await scopedDb.insert(schema.rigs).values(
        additions.map(({ index, rigId }) => ({
          id: rigId,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          name: `Huge rig ${index}`,
          description: `Valid maximum-size setup rig ${index}`,
          createdBy: grant.subjectId,
        })),
      );
      await scopedDb.insert(schema.rigVersions).values(
        additions.map(({ rigId, versionId }) => ({
          id: versionId,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          rigId,
          version: 1,
          image: "ubuntu:24.04",
          setupScript: MAX_SETUP,
          checks: [{ name: "ready", command: "true" }],
          credentialHooks: ["github"],
          defaultVariableSetIds: [],
          changelog: "Initial maximum-size rig",
          providerImages: {},
          createdBy: grant.subjectId,
          active: true,
        })),
      );
    });
    seeded = count;

    const dbMs: number[] = [];
    const stringifyMs: number[] = [];
    const parseMs: number[] = [];
    const summaryDbMs: number[] = [];
    const summaryStringifyMs: number[] = [];
    const summaryParseMs: number[] = [];
    let fullBytes = 0;
    let fullGzipBytes = 0;
    let summaryBytes = 0;
    let summaryGzipBytes = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const dbStartedAt = performance.now();
      const rigs = await listRigs(client.db, grant.workspaceId);
      dbMs.push(performance.now() - dbStartedAt);
      if (rigs.length !== count) throw new Error(`listed ${rigs.length}/${count} rigs`);

      const stringifyStartedAt = performance.now();
      const serialized = JSON.stringify(rigs);
      stringifyMs.push(performance.now() - stringifyStartedAt);
      fullBytes = Buffer.byteLength(serialized);
      fullGzipBytes = gzipSync(serialized).byteLength;

      const parseStartedAt = performance.now();
      const parsed = JSON.parse(serialized) as unknown[];
      parseMs.push(performance.now() - parseStartedAt);
      if (parsed.length !== count) throw new Error(`parsed ${parsed.length}/${count} rigs`);

      const summaryDbStartedAt = performance.now();
      const summaries = await listRigSummaries(client.db, grant.workspaceId);
      summaryDbMs.push(performance.now() - summaryDbStartedAt);
      if (summaries.length !== count) {
        throw new Error(`listed ${summaries.length}/${count} rig summaries`);
      }
      if (summaries.some((rig) => rig.activeVersion && "setupScript" in rig.activeVersion)) {
        throw new Error("rig summary leaked a setup definition body");
      }
      if (summaries.some((rig, index) => rig.id !== rigs[index]?.id)) {
        throw new Error("rig summary changed list membership or ordering");
      }

      const summaryStringifyStartedAt = performance.now();
      const summary = JSON.stringify(summaries);
      summaryStringifyMs.push(performance.now() - summaryStringifyStartedAt);
      summaryBytes = Buffer.byteLength(summary);
      summaryGzipBytes = gzipSync(summary).byteLength;

      const summaryParseStartedAt = performance.now();
      const parsedSummaries = JSON.parse(summary) as unknown[];
      summaryParseMs.push(performance.now() - summaryParseStartedAt);
      if (parsedSummaries.length !== count) {
        throw new Error(`parsed ${parsedSummaries.length}/${count} rig summaries`);
      }
    }
    receipts.push({
      count,
      samples: SAMPLES,
      setupCharactersPerRig: MAX_SETUP.length,
      setupUtf8BytesPerRig: Buffer.byteLength(MAX_SETUP),
      fullPayloadBytes: fullBytes,
      fullPayloadGzipBytes: fullGzipBytes,
      displaySummaryPayloadBytes: summaryBytes,
      displaySummaryPayloadGzipBytes: summaryGzipBytes,
      fullDbMs: distribution(dbMs),
      fullStringifyMs: distribution(stringifyMs),
      fullParseMs: distribution(parseMs),
      summaryDbMs: distribution(summaryDbMs),
      summaryStringifyMs: distribution(summaryStringifyMs),
      summaryParseMs: distribution(summaryParseMs),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        dataShape:
          "valid rigs with maximum 131072-character high-entropy Unicode comment setup scripts",
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

function buildMaxSetup(): string {
  let state = 0x5eed1234;
  const characters = ["#"];
  for (let index = 1; index < 131_072; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    characters.push(String.fromCharCode(0x4e00 + (state % 20_000)));
  }
  return characters.join("");
}

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
