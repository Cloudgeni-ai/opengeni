import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  databaseLoginAttemptOf,
  databaseUrlPassword,
  isDatabaseAuthenticationFailure,
  RotatingDatabasePassword,
  withDatabaseAuthenticationRetry,
  type DatabaseCredentialEvent,
  type DatabasePasswordFiles,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { Pool, type PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

import { createManagedAuthDatabasePool, rotatingPasswordClient } from "../src/auth/managed-auth";

// The managed-auth `pg` pool against a real server: each refused login is
// attributed to the password that client used. The previous file holds a
// password the server refuses; no role is altered, so this runs in parallel
// with other test files.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const REFUSED_PASSWORD = ["refused", "pw", "M8q"].join("-");

let shared: SharedTestDatabase | null = null;
let validPassword: string;
let refusedUrl: string;
let directory: string;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-database-credentials");
  if (!shared && requireRealDatabase) {
    throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
  }
  if (!shared) return;
  validPassword = databaseUrlPassword(shared.appUrl);
  const url = new URL(shared.appUrl);
  url.password = REFUSED_PASSWORD;
  refusedUrl = url.href;
  directory = await mkdtemp(join(tmpdir(), "opengeni-managed-auth-credentials-"));
}, 180_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  await shared?.release();
}, 60_000);

let fileCounter = 0;
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

const typesOf = (events: DatabaseCredentialEvent[], type: DatabaseCredentialEvent["type"]) =>
  events.filter((event) => event.type === type);

describe("managed-auth pool credentials", () => {
  test("a refused login's error names the client that logged in; one password fails fast", async () => {
    if (!shared) return;
    const events: DatabaseCredentialEvent[] = [];
    const pool = createManagedAuthDatabasePool(
      shared.appUrl,
      undefined,
      await passwordFiles({ current: REFUSED_PASSWORD }),
      (event) => events.push(event),
    );
    try {
      const viaQuery = await pool.query("select 1").catch((error: unknown) => error);
      const viaConnect = await pool.connect().catch((error: unknown) => error);
      for (const outcome of [viaQuery, viaConnect]) {
        expect(isDatabaseAuthenticationFailure(outcome)).toBe(true);
        expect(databaseLoginAttemptOf(outcome)).toBeDefined();
        expect(String(outcome)).not.toContain(REFUSED_PASSWORD);
      }
      // One login per operation: no retry, no switch, no exhausted event.
      expect(typesOf(events, "candidate_refused")).toHaveLength(2);
      expect(typesOf(events, "candidate_switched")).toEqual([]);
      expect(typesOf(events, "candidates_exhausted")).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  test("concurrent checkouts through a rotation switch once and all succeed", async () => {
    if (!shared) return;
    const events: DatabaseCredentialEvent[] = [];
    const pool = createManagedAuthDatabasePool(
      refusedUrl,
      undefined,
      await passwordFiles({ previous: REFUSED_PASSWORD, current: validPassword }),
      (event) => events.push(event),
    );
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 24 }, (_, index) =>
          pool.query<{ value: number }>("select $1::int as value", [index]),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      expect(typesOf(events, "candidate_switched")).toHaveLength(1);
      expect(typesOf(events, "candidates_exhausted")).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  test("mirrored rollback with every client logging in: the pool switches back at once, no operation fails", async () => {
    if (!shared) return;
    const events: DatabaseCredentialEvent[] = [];
    const source = new RotatingDatabasePassword({
      files: await passwordFiles({ previous: validPassword, current: REFUSED_PASSWORD }),
      fallbackPassword: REFUSED_PASSWORD,
      onEvent: (event) => events.push(event),
    });
    await source.password();
    // Hold every client before it reads its password, then after, so the pool
    // switches between the operations' start and their logins' reads, and
    // every login is in flight when the first refusal arrives.
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
    const read = source.password.bind(source);
    source.password = async (login?: object) => {
      if (held.beforeRead) {
        held.reading += 1;
        await held.beforeRead;
      }
      const password = await read(login);
      if (held.beforeAnswer) {
        held.answering += 1;
        await held.beforeAnswer;
      }
      return password;
    };
    const max = 6;
    const pool = new Pool({
      ...(parseConnectionString(shared.appUrl) as unknown as PoolConfig),
      max,
      Client: rotatingPasswordClient(source) as unknown as PoolConfig["Client"],
    });
    const waitFor = async (done: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!done() && Date.now() < deadline) await Bun.sleep(5);
      expect(done()).toBe(true);
    };
    try {
      const operations = Array.from({ length: 24 }, (_, index) =>
        withDatabaseAuthenticationRetry(source, () =>
          pool.query<{ value: number }>("select $1::int as value", [index]),
        ),
      );
      await waitFor(() => held.reading === max);
      // The pool switched to the new password moments ago (the forward
      // rotation); the rollback restored the old one.
      source.reportAuthenticationFailure(source.position());
      const mark = events.length;
      held.beforeRead = undefined;
      releaseRead();
      await waitFor(() => held.answering === max);
      held.beforeAnswer = undefined;
      releaseAnswer();
      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      const after = events.slice(mark);
      const refusals = typesOf(after, "candidate_refused");
      expect(refusals).toHaveLength(max);
      expect(refusals[0]).toEqual({
        type: "candidate_refused",
        index: 1,
        candidates: 2,
        stale: false,
      });
      expect(
        refusals.filter((event) => event.type === "candidate_refused" && event.stale),
      ).toHaveLength(max - 1);
      expect(typesOf(after, "candidate_switched")).toEqual([
        { type: "candidate_switched", fromIndex: 1, toIndex: 0, candidates: 2 },
      ]);
      expect(typesOf(events, "candidates_exhausted")).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
