#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type MigrationDeploymentMode = "historical" | "rolling" | "maintenance";

interface MigrationContractEntry {
  path: string;
  sha256: string;
  deploymentMode: MigrationDeploymentMode;
}

export interface SchemaContract {
  schemaVersion: 2;
  sha256: string;
  fileCount: number;
  latestMigration: string | null;
  migrations: MigrationContractEntry[];
}

export async function buildSchemaContract(
  migrationDirectory = join(import.meta.dir, "../packages/db/drizzle"),
): Promise<SchemaContract> {
  const files = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareStrings);
  const hash = createHash("sha256");
  const migrations: MigrationContractEntry[] = [];
  for (const path of files) {
    const content = await readFile(join(migrationDirectory, path));
    updateFrame(hash, Buffer.from(path));
    updateFrame(hash, content);
    migrations.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      deploymentMode: deploymentMode(content.toString("utf8")),
    });
  }
  return {
    schemaVersion: 2,
    sha256: hash.digest("hex"),
    fileCount: files.length,
    latestMigration: files.at(-1) ?? null,
    migrations,
  };
}

function deploymentMode(content: string): MigrationDeploymentMode {
  const firstLine = content.replaceAll("\r\n", "\n").split("\n", 1)[0]?.trim();
  if (firstLine === "-- deployment-mode: rolling") return "rolling";
  if (firstLine === "-- deployment-mode: maintenance") return "maintenance";
  return "historical";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updateFrame(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await buildSchemaContract())}\n`);
}
