import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";

import { createDb, rawRows, sessionListChangesFor } from "../src/database";
import {
  databaseUrlPassword,
  isDatabaseAuthenticationFailure,
  type DatabaseCredentialEvent,
  type DatabasePasswordFiles,
} from "../src/database-credentials";

// createDb with mounted password files against a real server. The previous
// file holds a password the server refuses (as right after the role changed) and
// the current file the valid one. No role is altered, so this runs in parallel
// with other test files.

let shared: SharedTestDatabase;
let validPassword: string;
let refusedUrl: string;
let directory: string;
const REFUSED_PASSWORD = ["refused", "pw", "T4v"].join("-");

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("password-files");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  validPassword = databaseUrlPassword(shared.appUrl);
  const url = new URL(shared.appUrl);
  url.password = REFUSED_PASSWORD;
  refusedUrl = url.href;
  directory = await mkdtemp(join(tmpdir(), "opengeni-db-password-files-"));
}, 180_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await shared?.release();
}, 60_000);

let fileCounter = 0;
/** Fresh files per test: previous refused, current valid (unless overridden). */
async function passwordFiles(contents: {
  previous?: string;
  current?: string;
}): Promise<DatabasePasswordFiles> {
  fileCounter += 1;
  const currentPasswordFile = join(directory, `password-${fileCounter}`);
  const previousPasswordFile = join(directory, `previous-password-${fileCounter}`);
  if (contents.current !== undefined) await writeFile(currentPasswordFile, contents.current);
  if (contents.previous !== undefined) await writeFile(previousPasswordFile, contents.previous);
  return { currentPasswordFile, previousPasswordFile };
}

function recorder() {
  const events: Array<{ event: DatabaseCredentialEvent; connection?: string }> = [];
  return {
    events,
    listener: (event: DatabaseCredentialEvent, connection?: "pool" | "notifications") =>
      events.push({ event, ...(connection ? { connection } : {}) }),
    count: (type: DatabaseCredentialEvent["type"], connection = "pool") =>
      events.filter((entry) => entry.event.type === type && entry.connection === connection).length,
  };
}

describe("createDb password files", () => {
  test("queued queries and transactions refused with 28P01 are retried on the current password", async () => {
    const tally = recorder();
    const files = await passwordFiles({ previous: REFUSED_PASSWORD, current: validPassword });
    const client = createDb(refusedUrl, {
      max: 4,
      passwordFiles: files,
      onCredentialEvent: tally.listener,
    });
    try {
      const queries = Array.from({ length: 24 }, (_, index) =>
        rawRows<{ value: number }>(client.db, sql`select ${index}::int as value`),
      );
      const transactions = Array.from({ length: 4 }, (_, index) =>
        client.db.transaction(async (tx) => {
          const [row] = await rawRows<{ value: number }>(tx, sql`select ${index}::int as value`);
          return row!.value;
        }),
      );
      const rows = await Promise.all(queries);
      expect(rows.map((result) => result[0]!.value)).toEqual(
        Array.from({ length: 24 }, (_, index) => index),
      );
      expect(await Promise.all(transactions)).toEqual([0, 1, 2, 3]);
      // One switch; at most one refusal per connection that opened at once.
      expect(tally.count("candidate_switched")).toBe(1);
      expect(tally.count("candidate_refused")).toBeGreaterThanOrEqual(1);
      expect(tally.count("candidate_refused")).toBeLessThanOrEqual(4);
      expect(tally.count("candidates_exhausted")).toBe(0);
      // A fresh pool: `.values()` keeps its result mode across the retry.
      await client.close();
      const again = createDb(refusedUrl, {
        max: 1,
        maxLifetimeSeconds: 1,
        passwordFiles: files,
        onCredentialEvent: tally.listener,
      });
      try {
        const raw = await (
          again.db as unknown as {
            $client: { unsafe: (query: string) => { values: () => Promise<unknown[][]> } };
          }
        ).$client
          .unsafe("select 7 as value")
          .values();
        expect(raw).toEqual([[7]]);
      } finally {
        await again.close();
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    expect(JSON.stringify(tally.events)).not.toContain(validPassword);
    expect(JSON.stringify(tally.events)).not.toContain(REFUSED_PASSWORD);
  });

  test("the LISTEN connection switches to the current password too", async () => {
    const tally = recorder();
    const files = await passwordFiles({ previous: REFUSED_PASSWORD, current: validPassword });
    const client = createDb(refusedUrl, {
      max: 1,
      passwordFiles: files,
      notificationDatabaseUrl: refusedUrl,
      onCredentialEvent: tally.listener,
    });
    const states: string[] = [];
    const unsubscribe = sessionListChangesFor(client.db)!.subscribe((event) => {
      if (event.type !== "change") states.push(event.type);
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!states.includes("connected") && Date.now() < deadline) await Bun.sleep(50);
      expect(states).toContain("connected");
      expect(tally.count("candidate_switched", "notifications")).toBe(1);
    } finally {
      unsubscribe();
      await client.close();
    }
  });

  test("a single wrong password (current file only) fails fast with 28P01", async () => {
    const tally = recorder();
    const files = await passwordFiles({ current: REFUSED_PASSWORD });
    const client = createDb(shared.appUrl, {
      max: 1,
      passwordFiles: files,
      onCredentialEvent: tally.listener,
    });
    try {
      const outcome = await rawRows(client.db, sql`select 1`).catch((error: unknown) => error);
      expect(isDatabaseAuthenticationFailure(outcome)).toBe(true);
      expect(String(outcome)).not.toContain(REFUSED_PASSWORD);
      expect(String(outcome)).not.toContain(validPassword);
      // One refusal, no retry, no switch.
      expect(tally.count("candidate_refused")).toBe(1);
      expect(tally.count("candidate_switched")).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("without password files a 28P01 fails fast, unchanged", async () => {
    const tally = recorder();
    const client = createDb(refusedUrl, { max: 1, onCredentialEvent: tally.listener });
    try {
      const outcome = await rawRows(client.db, sql`select 1`).catch((error: unknown) => error);
      expect(isDatabaseAuthenticationFailure(outcome)).toBe(true);
      expect(String(outcome)).not.toContain(REFUSED_PASSWORD);
      expect(tally.events).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("configured but absent files use the URL password, as before", async () => {
    const tally = recorder();
    const files = await passwordFiles({});
    const client = createDb(shared.appUrl, {
      max: 1,
      passwordFiles: files,
      onCredentialEvent: tally.listener,
    });
    try {
      const [row] = await rawRows<{ value: number }>(client.db, sql`select 1::int as value`);
      expect(row!.value).toBe(1);
      expect(tally.events).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
