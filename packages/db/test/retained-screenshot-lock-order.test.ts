import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("retained screenshot prepare lock order", () => {
  test("takes the canonical event-write prefix before inserting the artifact", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/index.ts"), "utf8");
    const start = source.indexOf("export async function prepareRetainedScreenshotArtifact");
    const end = source.indexOf("export async function settleRetainedScreenshotArtifactReady");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("retryRlsPersistence");
    expect(body).toContain('controlLock: "none"');
    const prefix = body.indexOf("lockSessionEventWriteRows");
    const insert = body.indexOf("insert(schema.retainedScreenshotArtifacts)");
    expect(prefix).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(prefix);
  });
});
