import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSchemaContract } from "./release-schema-contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("release schema contract", () => {
  test("classifies the OPE-24 owning-human cutover as maintenance-only", async () => {
    const contract = await buildSchemaContract();
    expect(
      contract.migrations.find(
        (migration) => migration.path === "0065_codex_subscription_overview.sql",
      ),
    ).toMatchObject({ deploymentMode: "maintenance" });
  });

  test("is deterministic across creation order and classifies only executable SQL migrations", async () => {
    const first = await fixture([
      ["0002_second.sql", "-- deployment-mode: rolling\nselect 2;"],
      ["meta/_journal.json", '{"entries":[]}'],
      ["0001_first.sql", "select 1;"],
    ]);
    const second = await fixture([
      ["0001_first.sql", "select 1;"],
      ["meta/_journal.json", '{"entries":[]}'],
      ["0002_second.sql", "-- deployment-mode: rolling\nselect 2;"],
    ]);

    expect(await buildSchemaContract(first)).toEqual(await buildSchemaContract(second));
    expect(await buildSchemaContract(first)).toMatchObject({
      schemaVersion: 2,
      fileCount: 2,
      latestMigration: "0002_second.sql",
      migrations: [
        expect.objectContaining({ path: "0001_first.sql", deploymentMode: "historical" }),
        expect.objectContaining({ path: "0002_second.sql", deploymentMode: "rolling" }),
      ],
    });
  });

  test("changes when either a path or file content changes", async () => {
    const baseline = await fixture([["0001_a.sql", "ab"]]);
    const changedContent = await fixture([["0001_a.sql", "ac"]]);
    const changedPath = await fixture([["0001_b.sql", "ab"]]);

    const baselineHash = (await buildSchemaContract(baseline)).sha256;
    expect((await buildSchemaContract(changedContent)).sha256).not.toBe(baselineHash);
    expect((await buildSchemaContract(changedPath)).sha256).not.toBe(baselineHash);
  });
});

async function fixture(files: Array<[string, string]>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-schema-contract-"));
  directories.push(directory);
  for (const [path, content] of files) {
    const absolutePath = join(directory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return directory;
}
