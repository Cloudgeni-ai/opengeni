import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { developmentSchemaFingerprint, watchDevelopmentSchema } from "./watch-development-schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-schema-watch-"));
  roots.push(root);
  await mkdir(join(root, "packages/db/drizzle"), { recursive: true });
  await writeFile(join(root, "packages/db/drizzle/0001_first.sql"), "select 1;\n");
  return root;
}

describe("development schema watcher", () => {
  test("fingerprint is stable across directory ordering and changes with SQL", async () => {
    const root = await fixture();
    const first = await developmentSchemaFingerprint(root);
    await writeFile(join(root, "packages/db/drizzle/readme.txt"), "ignored\n");
    expect(await developmentSchemaFingerprint(root)).toBe(first);
    await writeFile(join(root, "packages/db/drizzle/0001_first.sql"), "select 2;\n");
    expect(await developmentSchemaFingerprint(root)).not.toBe(first);
  });

  test("settles when a migration is added after startup", async () => {
    const root = await fixture();
    const watching = watchDevelopmentSchema(root, { intervalMs: 5 });
    await Bun.sleep(10);
    await writeFile(join(root, "packages/db/drizzle/0002_second.sql"), "select 2;\n");
    expect(await watching).toBe("changed");
  });
});
