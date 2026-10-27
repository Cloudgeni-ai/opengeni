import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { createDb, rawRows, sessionListChangesFor } from "../src/database";
import { createSessionListChangeSource } from "../src/session-list-notifications";
import {
  databaseLoginAttemptOf,
  databaseUrlPassword,
  isDatabaseAuthenticationFailure,
  RotatingDatabasePassword,
  withDatabaseAuthenticationRetry,
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
const OTHER_REFUSED_PASSWORD = ["refused", "pw", "W6n"].join("-");

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

  test("with both passwords wrong, the LISTEN connection retries at once only a few times, then at the reconnect delay", async () => {
    const tally = recorder();
    const source = new RotatingDatabasePassword({
      files: await passwordFiles({ previous: REFUSED_PASSWORD, current: OTHER_REFUSED_PASSWORD }),
      fallbackPassword: REFUSED_PASSWORD,
      onEvent: (event) => tally.listener(event, "notifications"),
    });
    const listener = createSessionListChangeSource(refusedUrl, {
      reconnectDelayMs: 250,
      credential: source,
    });
    const unsubscribe = listener.subscribe(() => undefined);
    try {
      await Bun.sleep(1_600);
    } finally {
      unsubscribe();
      await listener.close();
    }
    const refusals = tally.count("candidate_refused", "notifications");
    // The first login and at most four immediate retries, then one login per
    // 250 ms delay: about 11 in 1.6 s. Resetting the immediate retries after
    // every delay would allow five logins per delay (about 35).
    expect(refusals).toBeGreaterThanOrEqual(5);
    expect(refusals).toBeLessThanOrEqual(14);
    expect(tally.count("candidates_exhausted", "notifications")).toBe(0);
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
      // The driver names the refused login, so the refusal is attributed to it.
      expect(databaseLoginAttemptOf(outcome)).toBeDefined();
      expect(String(outcome)).not.toContain(REFUSED_PASSWORD);
      expect(String(outcome)).not.toContain(validPassword);
      const transaction = await client.db
        .transaction(async () => undefined)
        .catch((error: unknown) => error);
      expect(isDatabaseAuthenticationFailure(transaction)).toBe(true);
      expect(databaseLoginAttemptOf(transaction)).toBeDefined();
      // One refusal per operation, no retry, no switch.
      expect(tally.count("candidate_refused")).toBe(2);
      expect(tally.count("candidate_switched")).toBe(0);
      expect(tally.count("candidates_exhausted")).toBe(0);
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

/**
 * The real postgres.js driver (with our patch) and server: every connection of
 * the pool starts logging in and waits before it asks for the password until
 * all of them do; with `selectSecond`, the pool then switches to the second
 * candidate (after the operations started, before their logins read). Every
 * login then reads its password and is held until all of them did, and only
 * then are they answered. Only the server's valid password is fixed; `files`
 * decide which candidate is the refused one.
 */
async function concurrentLoginsAtSwitch(
  files: { previous: string; current: string },
  options: { selectSecond: boolean },
) {
  const events: DatabaseCredentialEvent[] = [];
  const source = new RotatingDatabasePassword({
    files: await passwordFiles(files),
    fallbackPassword: REFUSED_PASSWORD,
    onEvent: (event) => events.push(event),
  });
  await source.password();
  let releaseRead!: () => void;
  let releaseAnswer!: () => void;
  const held: {
    reading: number;
    answering: number;
    beforeRead?: Promise<void> | undefined;
    beforeAnswer?: Promise<void> | undefined;
  } = {
    reading: 0,
    answering: 0,
    beforeRead: new Promise<void>((resolve) => (releaseRead = resolve)),
    beforeAnswer: new Promise<void>((resolve) => (releaseAnswer = resolve)),
  };
  const max = 6;
  const driver = postgres(shared.appUrl, {
    max,
    onnotice: () => undefined,
    pass: async (login) => {
      if (held.beforeRead) {
        held.reading += 1;
        await held.beforeRead;
      }
      const password = await source.password(login);
      if (held.beforeAnswer) {
        held.answering += 1;
        await held.beforeAnswer;
      }
      return password;
    },
  });
  const waitFor = async (done: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!done() && Date.now() < deadline) await Bun.sleep(5);
    expect(done()).toBe(true);
  };
  try {
    const operations = Array.from({ length: 30 }, (_, index) =>
      withDatabaseAuthenticationRetry(source, async () => {
        const [row] = await driver<{ value: number }[]>`select ${index}::int as value`;
        return row!.value;
      }),
    );
    await waitFor(() => held.reading === max);
    // The pool switched to the second candidate after these operations started.
    if (options.selectSecond) source.reportAuthenticationFailure(source.position());
    const mark = events.length;
    held.beforeRead = undefined;
    releaseRead();
    await waitFor(() => held.answering === max);
    held.beforeAnswer = undefined;
    releaseAnswer();
    const outcomes = await Promise.allSettled(operations);
    return { events: events.slice(mark), outcomes, source, max };
  } finally {
    await driver.end({ timeout: 5 });
  }
}

describe("concurrent logins at the moment of a switch (real driver)", () => {
  test("forward: each in-flight login's refusal counts once, the first switches, no operation fails", async () => {
    const run = await concurrentLoginsAtSwitch(
      { previous: REFUSED_PASSWORD, current: validPassword },
      { selectSecond: false },
    );
    expect(run.outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    const refusals = run.events.filter((event) => event.type === "candidate_refused");
    expect(refusals).toHaveLength(run.max);
    expect(refusals[0]).toEqual({
      type: "candidate_refused",
      index: 0,
      candidates: 2,
      stale: false,
    });
    expect(
      refusals.filter((event) => event.type === "candidate_refused" && event.stale),
    ).toHaveLength(run.max - 1);
    expect(run.events.filter((event) => event.type === "candidate_switched")).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "candidates_exhausted")).toEqual([]);
    expect(run.source.candidateIndex).toBe(1);
  });

  test("mirrored rollback: a pool that just switched switches back at once, no operation fails", async () => {
    const run = await concurrentLoginsAtSwitch(
      { previous: validPassword, current: REFUSED_PASSWORD },
      { selectSecond: true },
    );
    expect(run.outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    const refusals = run.events.filter((event) => event.type === "candidate_refused");
    expect(refusals).toHaveLength(run.max);
    // Attributed to the password each login used, not to the one selected
    // when its operation started: the first refusal is fresh.
    expect(refusals[0]).toEqual({
      type: "candidate_refused",
      index: 1,
      candidates: 2,
      stale: false,
    });
    expect(
      refusals.filter((event) => event.type === "candidate_refused" && event.stale),
    ).toHaveLength(run.max - 1);
    expect(run.events.filter((event) => event.type === "candidate_switched")).toEqual([
      { type: "candidate_switched", fromIndex: 1, toIndex: 0, candidates: 2 },
    ]);
    expect(run.events.filter((event) => event.type === "candidates_exhausted")).toEqual([]);
    expect(run.source.candidateIndex).toBe(0);
  });
});
