import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import {
  buildRlsScopeStatement,
  rlsScopeStatement,
  type Database,
  type RlsScopeInput,
  type RlsScopeLock,
  type RlsScopeValues,
} from "../src/database";

/**
 * The RLS scope statement is rendered once per shape and then bound with each
 * scope's values. Every shape must render the identical text, parameters and
 * typings as building the statement afresh, from its first use onwards.
 */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  for (let i = 0; i < 8; i++) next();
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!,
  };
}

const STRINGS = ["", "acct-1", "ws-$1", "$2", "é😀", "a'b", "x\u0000y", crypto.randomUUID()];

function scope(rng: ReturnType<typeof random>): { input: RlsScopeInput; values: RlsScopeValues } {
  const locks: RlsScopeLock[] = Array.from({ length: rng.int(4) }, () => ({
    key: rng.next() < 0.5 ? rng.pick(STRINGS) : { accountPrefix: rng.pick(STRINGS) },
    mode: rng.pick(["shared", "exclusive"] as const),
    hash: rng.pick(["extended", "text"] as const),
  }));
  const accountId = rng.next() < 0.5 ? null : rng.pick(STRINGS.filter(Boolean));
  const workspaceId = accountId === null || rng.next() < 0.7 ? rng.pick(STRINGS) : null;
  const actor = rng.next() < 0.5;
  const subjectId = rng.next() < 0.5 ? rng.pick(STRINGS) : undefined;
  return {
    input: { accountId, workspaceId, ...(subjectId ? { subjectId } : {}), locks, readParent: true },
    values: {
      accountId,
      workspaceId,
      settingsWorkspaceId: workspaceId ?? "",
      agentRootSessionId: rng.pick(STRINGS),
      siteId: rng.pick(STRINGS),
      siteViewerPrincipal: rng.pick(STRINGS),
      subjectId,
      privateFileOwner: actor ? rng.pick(STRINGS) : undefined,
      initiatingHumanSubjectId: actor ? rng.pick(STRINGS) : undefined,
      lockKeys: locks.map((lock) =>
        typeof lock.key === "string" ? lock.key : lock.key.accountPrefix,
      ),
    },
  };
}

test("cached RLS scope statements render exactly as freshly built ones for every shape", () => {
  const db = drizzle.mock() as unknown as Database;
  const dialect = (db as unknown as { dialect: { sqlToQuery(query: SQL): unknown } }).dialect;
  const shapes = new Set<string>();
  for (let seed = 1; seed <= 3_000; seed++) {
    const { input, values } = scope(random(seed));
    shapes.add(
      JSON.stringify([
        input.accountId === null,
        values.subjectId === undefined,
        values.privateFileOwner === undefined,
        input.locks.map((lock) => [typeof lock.key, lock.mode, lock.hash]),
      ]),
    );
    const expected = dialect.sqlToQuery(buildRlsScopeStatement(input, values));
    // The first call of a shape compiles it; every later call uses the template.
    expect(dialect.sqlToQuery(rlsScopeStatement(db, input, values))).toEqual(expected);
    expect(dialect.sqlToQuery(rlsScopeStatement(db, input, values))).toEqual(expected);
  }
  expect(shapes.size).toBeGreaterThan(300);
});
