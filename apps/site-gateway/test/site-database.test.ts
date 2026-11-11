/**
 * Unit: the Durable Object's request-id bookkeeping over time (the workerd
 * suite in site-db.miniflare.test.ts covers everything else).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  SiteDatabase,
  uniqueColumnNames,
  type DurableObjectStateLike,
  type SyncKvStorage,
} from "../src/site-database";

function memoryKv(): SyncKvStorage & { keys(): string[] } {
  const entries = new Map<string, unknown>();
  const sorted = () => [...entries.keys()].sort();
  return {
    keys: sorted,
    get: <T>(key: string) => entries.get(key) as T | undefined,
    put: (key, value) => void entries.set(key, value),
    delete: (key) => entries.delete(key),
    list: <T>(options: { prefix?: string; start?: string; end?: string; limit?: number } = {}) =>
      sorted()
        .filter(
          (key) =>
            (!options.prefix || key.startsWith(options.prefix)) &&
            (options.start === undefined || key >= options.start) &&
            (options.end === undefined || key < options.end),
        )
        .slice(0, options.limit ?? Infinity)
        .map((key): [string, T] => [key, entries.get(key) as T]),
  };
}

function database() {
  const kv = memoryKv();
  const state: DurableObjectStateLike = {
    storage: {
      kv,
      sql: {
        databaseSize: 4096,
        exec: () => {
          throw new Error("not used");
        },
      },
      transactionSync: (closure) => closure(),
      deleteAll: async () => {},
    },
    blockConcurrencyWhile: (callback) => callback(),
  };
  return { kv, db: new SiteDatabase(state, {}) };
}

async function inspect(db: SiteDatabase, requestId: string) {
  const response = await db.fetch(
    new Request("https://site-db.internal/inspect", {
      method: "POST",
      body: JSON.stringify({ requestId, migrationsOnly: true }),
    }),
  );
  return response.status;
}

afterEach(() => {
  setSystemTime();
});

describe("SiteDatabase request ids", () => {
  test("are refused for a few minutes, then forgotten in bounded batches", async () => {
    const { kv, db } = database();
    const start = Date.UTC(2026, 9, 14, 12, 0, 0);
    setSystemTime(new Date(start));
    const first = crypto.randomUUID();
    expect(await inspect(db, first)).toBe(200);
    expect(await inspect(db, first)).toBe(409);
    setSystemTime(new Date(start + 150_000));
    expect(await inspect(db, first)).toBe(409);
    for (let index = 0; index < 300; index += 1)
      expect(await inspect(db, crypto.randomUUID())).toBe(200);
    expect(kv.keys()).toHaveLength(301);
    // Three minutes on: each request drops at most 256 old ids.
    setSystemTime(new Date(start + 330_000));
    expect(await inspect(db, crypto.randomUUID())).toBe(200);
    expect(kv.keys()).toHaveLength(301 - 256 + 1);
    expect(await inspect(db, crypto.randomUUID())).toBe(200);
    expect(kv.keys()).toHaveLength(2);
    expect(kv.keys().every((key) => key.startsWith("rq:"))).toBe(true);
  });
});

describe("uniqueColumnNames", () => {
  test("renames repeats without taking another column's name", () => {
    expect(uniqueColumnNames(["a", "b"])).toEqual(["a", "b"]);
    expect(uniqueColumnNames(["a", "a", "a"])).toEqual(["a", "a_2", "a_3"]);
    expect(uniqueColumnNames(["a", "a", "a_2"])).toEqual(["a", "a_3", "a_2"]);
    expect(uniqueColumnNames(["a_2", "a", "a"])).toEqual(["a_2", "a", "a_3"]);
  });
});
