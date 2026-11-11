import { expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { loadVerifiedAttemptToolCatalogTx } from "../src/attempt-tool-catalogs";
import type { Database } from "../src/database";

test("concurrent fills count a retained catalog once, while every hit still reads its head", async () => {
  const scope = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  };
  // Seven concurrent copies exceed the existing 64 MiB budget; the one retained
  // catalog does not. Use a stored JSON copy, not the constructor's identity cache.
  const stored = JSON.parse(
    JSON.stringify(
      createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [
          {
            identity: { serverId: "docs", toolName: "search" },
            modelName: "docs__search",
            description: "Search",
            inputSchema: { type: "object", description: "x".repeat(10 * 1024 * 1024) },
            source: "docs",
            approval: "none",
            execute: async () => ({ content: [] }),
          },
        ],
      }).catalog,
    ),
  );
  let release!: () => void;
  const allFillsStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heads = 0;
  let fills = 0;
  let visible = true;
  const tx = {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (!("catalog" in fields)) {
              heads++;
              return visible ? [{ digest: stored.digest }] : [];
            }
            fills++;
            if (fills === 7) release();
            await allFillsStarted;
            return [{ catalog: stored, contentRefs: null, digest: stored.digest, generation: 1 }];
          },
        }),
      }),
    }),
  } as unknown as Pick<Database, "select">;
  const read = () => loadVerifiedAttemptToolCatalogTx(tx, scope);
  const results = await Promise.all(Array.from({ length: 7 }, read));
  expect(heads).toBe(7);
  expect(fills).toBe(7);
  for (const result of results) {
    expect(result?.digest).toBe(stored.digest);
    expect(Object.isFrozen(result?.entries[0]?.inputSchema)).toBe(true);
  }
  const hit = await read();
  expect(hit?.digest).toBe(stored.digest);
  expect(heads).toBe(8);
  expect(fills).toBe(7);
  expect(await read()).toBe(hit);
  expect(heads).toBe(9);
  expect(fills).toBe(7);
  visible = false;
  expect(await read()).toBeNull();
  expect(heads).toBe(10);
  expect(fills).toBe(7);
}, 20_000);
