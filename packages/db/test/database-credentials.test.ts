import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservability } from "@opengeni/observability";
import {
  DATABASE_AUTHENTICATION_MAX_ATTEMPTS,
  DATABASE_CREDENTIAL_METRICS,
  databaseCredentialEventAttributes,
  databaseLoginAttemptOf,
  databasePasswordFileOptions,
  databasePasswordFileOptionsFromEnvironment,
  databaseUrlPassword,
  databaseUrlUser,
  isDatabaseAuthenticationFailure,
  logDatabaseCredentialEvent,
  observeDatabaseCredentialEvents,
  RotatingDatabasePassword,
  rotatingDatabasePasswordFor,
  tagDatabaseLoginAttempt,
  withDatabaseAuthenticationRetry,
  type DatabaseCredentialEvent,
} from "../src/database-credentials";

// Distinctive values so any leak into an event, error or log is detectable.
const URL_PASSWORD = ["url", "pw", "Q7x"].join("-");
const OLD_PASSWORD = ["old", "pw", "K2m"].join("-");
const NEW_PASSWORD = ["new", "pw", "Z9r"].join("-");
const SECRETS = [URL_PASSWORD, OLD_PASSWORD, NEW_PASSWORD];

let directory: string;
let current: string;
let previous: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opengeni-db-credentials-"));
  current = join(directory, "password");
  previous = join(directory, "previous-password");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function credential(events: DatabaseCredentialEvent[] = []) {
  return new RotatingDatabasePassword({
    files: { currentPasswordFile: current, previousPasswordFile: previous },
    fallbackPassword: URL_PASSWORD,
    onEvent: (event) => events.push(event),
  });
}

async function rotating(events: DatabaseCredentialEvent[] = []) {
  await writeFile(previous, `${OLD_PASSWORD}\n`);
  await writeFile(current, `${NEW_PASSWORD}\n`);
  const source = credential(events);
  await source.password();
  return source;
}

function expectNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** A PostgreSQL 28P01 as postgres.js and pg raise it (message without the password). */
function refused(): Error {
  return Object.assign(new Error('password authentication failed for user "opengeni_app"'), {
    code: "28P01",
  });
}

/** A 28P01 tagged with the login that raised it, as our drivers tag it. */
function refusedBy(login: object): Error {
  const error = refused();
  tagDatabaseLoginAttempt(error, login);
  return error;
}

/** A fake server that accepts exactly one password, like PostgreSQL. */
function server(valid: { password: string }) {
  const attempts: string[] = [];
  return {
    attempts,
    /** `login`: the driver's identity of this login, tagged onto its 28P01. */
    connect: async (password: string, login?: object) => {
      attempts.push(password === OLD_PASSWORD ? "old" : password === NEW_PASSWORD ? "new" : "?");
      if (password !== valid.password) {
        const error = refused();
        if (login) tagDatabaseLoginAttempt(error, login);
        throw error;
      }
      return "ok";
    },
  };
}

describe("database password files", () => {
  test("unset settings keep the URL password (no options, no credential)", () => {
    expect(databasePasswordFileOptions({})).toEqual({});
    expect(databasePasswordFileOptions({ databasePasswordFile: "  " })).toEqual({});
    expect(databasePasswordFileOptionsFromEnvironment({})).toEqual({});
    expect(rotatingDatabasePasswordFor("postgres://u:p@h/db", undefined, undefined)).toBe(
      undefined,
    );
    expect(
      databasePasswordFileOptionsFromEnvironment({
        OPENGENI_DATABASE_PASSWORD_FILE: "/run/a",
        OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE: "/run/b",
      }),
    ).toEqual({ passwordFiles: { currentPasswordFile: "/run/a", previousPasswordFile: "/run/b" } });
  });

  test("missing files fall back to the URL password", async () => {
    const source = credential();
    expect(await source.password()).toBe(URL_PASSWORD);
    expect(source.candidateCount).toBe(1);
  });

  test("an empty current file falls back to the URL password", async () => {
    await writeFile(current, "");
    await writeFile(previous, "\n");
    const source = credential();
    expect(await source.password()).toBe(URL_PASSWORD);
    expect(source.candidateCount).toBe(1);
  });

  test("the current file replaces the URL password; a trailing newline is not part of it", async () => {
    await writeFile(current, `${NEW_PASSWORD}\n`);
    const source = credential();
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(source.candidateCount).toBe(1);
  });

  test("previous comes first; a previous equal to current is deduplicated", async () => {
    await writeFile(current, NEW_PASSWORD);
    await writeFile(previous, OLD_PASSWORD);
    const source = credential();
    expect(await source.password()).toBe(OLD_PASSWORD);
    expect(source.candidateCount).toBe(2);

    await writeFile(previous, NEW_PASSWORD);
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(source.candidateCount).toBe(1);
  });

  test("previous alone pairs with the URL password as current", async () => {
    await writeFile(previous, OLD_PASSWORD);
    const source = credential();
    expect(await source.password()).toBe(OLD_PASSWORD);
    source.reportAuthenticationFailure(source.position());
    expect(await source.password()).toBe(URL_PASSWORD);
  });

  test("the files are read on every call, so updates apply without a restart", async () => {
    let reads = 0;
    const source = new RotatingDatabasePassword({
      files: { currentPasswordFile: current },
      fallbackPassword: URL_PASSWORD,
      readPasswordFile: async (path) => {
        reads += 1;
        return Bun.file(path).text();
      },
    });
    await writeFile(current, OLD_PASSWORD);
    expect(await source.password()).toBe(OLD_PASSWORD);
    await writeFile(current, NEW_PASSWORD);
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(reads).toBe(2);
  });

  test("a slower earlier read never undoes a newer one", async () => {
    let release: (() => void) | undefined;
    let contents = OLD_PASSWORD;
    let calls = 0;
    const source = new RotatingDatabasePassword({
      files: { currentPasswordFile: current },
      fallbackPassword: URL_PASSWORD,
      readPasswordFile: async () => {
        calls += 1;
        const value = contents;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return value;
      },
    });
    const slow = source.password();
    contents = NEW_PASSWORD;
    expect(await source.password()).toBe(NEW_PASSWORD);
    release!();
    await slow;
    expect(await source.password()).toBe(NEW_PASSWORD);
  });

  test("current is read before previous, so a Secret update never yields only the new password", async () => {
    // kubelet switches both files at once, between any two reads. Before the
    // switch: no keys (URL password). After: previous = old, current = new.
    // With current read first, a switch between the two reads gives [old, new]
    // or [URL]; never [new] while the role still has the old password.
    const ENOENT = Object.assign(new Error("missing"), { code: "ENOENT" });
    for (const switchAfterReads of [0, 1, 2]) {
      let reads = 0;
      let currentDone = false;
      const order: string[] = [];
      const source = new RotatingDatabasePassword({
        files: { currentPasswordFile: current, previousPasswordFile: previous },
        fallbackPassword: OLD_PASSWORD,
        readPasswordFile: async (path) => {
          const switched = reads >= switchAfterReads;
          reads += 1;
          // Previous is opened only once current has been read.
          order.push(path === current ? "current" : `previous:${currentDone}`);
          await Bun.sleep(1);
          if (path === current) currentDone = true;
          if (!switched) throw ENOENT;
          return path === current ? NEW_PASSWORD : OLD_PASSWORD;
        },
      });
      expect(await source.password()).toBe(OLD_PASSWORD);
      expect(order).toEqual(["current", "previous:true"]);
      expect(source.candidateCount).toBe(switchAfterReads === 0 ? 2 : 1);
    }
  });

  test("an unreadable file is treated as missing and reported once, without contents", async () => {
    const events: DatabaseCredentialEvent[] = [];
    const source = new RotatingDatabasePassword({
      files: { currentPasswordFile: current, previousPasswordFile: previous },
      fallbackPassword: URL_PASSWORD,
      onEvent: (event) => events.push(event),
      readPasswordFile: async (path) => {
        if (path === current) {
          throw Object.assign(new Error(`EACCES: permission denied, open ${NEW_PASSWORD}`), {
            code: "EACCES",
          });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await source.password()).toBe(URL_PASSWORD);
    expect(await source.password()).toBe(URL_PASSWORD);
    expect(events).toEqual([{ type: "password_file_unreadable", file: "current", code: "EACCES" }]);
    expectNoSecret(events);
  });

  test("an unreadable file on disk falls back without throwing", async () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    await writeFile(current, NEW_PASSWORD);
    await chmod(current, 0o000);
    const events: DatabaseCredentialEvent[] = [];
    expect(await credential(events).password()).toBe(URL_PASSWORD);
    expect(events[0]).toMatchObject({ type: "password_file_unreadable", file: "current" });
  });
});

describe("sticky candidate switch", () => {
  test("one 28P01 moves from previous to current, and it sticks", async () => {
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    const start = source.position();
    expect(await source.password()).toBe(OLD_PASSWORD);
    source.reportAuthenticationFailure(start);
    expect(source.candidateIndex).toBe(1);
    // Concurrent refusals of the previous password do not move it again.
    source.reportAuthenticationFailure(start);
    source.reportAuthenticationFailure(start);
    for (let read = 0; read < 3; read += 1) expect(await source.password()).toBe(NEW_PASSWORD);
    expect(events.filter((event) => event.type === "candidate_switched")).toEqual([
      { type: "candidate_switched", fromIndex: 0, toIndex: 1, candidates: 2 },
    ]);
    expect(events.filter((event) => event.type === "candidate_refused")).toHaveLength(3);
    expect(events.filter((event) => event.type === "candidates_exhausted")).toEqual([]);
  });

  test("each login's position is recorded and found again through its tagged 28P01", async () => {
    const source = await rotating();
    const login = {};
    expect(await source.password(login)).toBe(OLD_PASSWORD);
    // Nested, as drizzle or pg-pool wrap a driver error.
    const wrapped = new Error("wrapped", { cause: refusedBy(login) });
    expect(databaseLoginAttemptOf(wrapped)).toBe(login);
    expect(source.refusedPosition(wrapped)).toEqual({ generation: 0, selection: 0, index: 0 });
    // Untagged, or a login this source never handed a password: unknown.
    expect(source.refusedPosition(refused())).toBeUndefined();
    expect(source.refusedPosition(refusedBy({}))).toBeUndefined();
    expect(databaseLoginAttemptOf(null)).toBeUndefined();
    // The tag never leaks into a serialization of the error.
    expect(JSON.stringify(refusedBy(login))).toBe(JSON.stringify(refused()));
  });

  test("a stale refusal never moves the pool and reports itself as stale", async () => {
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    // Both logins read the previous password before either was refused.
    const first = {};
    const straggler = {};
    await source.password(first);
    await source.password(straggler);
    expect(source.reportAuthenticationFailure(source.refusedPosition(refusedBy(first))!)).toBe(
      "switched",
    );
    expect(source.reportAuthenticationFailure(source.refusedPosition(refusedBy(straggler))!)).toBe(
      "stale",
    );
    expect(source.candidateIndex).toBe(1);
    expect(events.filter((event) => event.type === "candidate_refused")).toEqual([
      { type: "candidate_refused", index: 0, candidates: 2, stale: false },
      { type: "candidate_refused", index: 0, candidates: 2, stale: true },
    ]);
  });

  test("a refusal of the newly selected password switches back at once: no grace", async () => {
    // A rollback restored the old password right after the pool switched.
    const source = await rotating();
    source.reportAuthenticationFailure(source.position());
    const login = {};
    expect(await source.password(login)).toBe(NEW_PASSWORD);
    expect(source.reportAuthenticationFailure(source.refusedPosition(refusedBy(login))!)).toBe(
      "switched",
    );
    expect(await source.password()).toBe(OLD_PASSWORD);
  });

  test("a login from before a switch and back is still stale", async () => {
    const source = await rotating();
    const early = {};
    await source.password(early);
    source.reportAuthenticationFailure(source.position());
    source.reportAuthenticationFailure(source.position());
    // Back on the previous password, but in a later selection.
    expect(source.candidateIndex).toBe(0);
    expect(source.reportAuthenticationFailure(source.refusedPosition(refusedBy(early))!)).toBe(
      "stale",
    );
    expect(source.candidateIndex).toBe(0);
  });

  test("a single candidate never switches", async () => {
    await writeFile(current, NEW_PASSWORD);
    const events: DatabaseCredentialEvent[] = [];
    const source = credential(events);
    await source.password();
    expect(source.reportAuthenticationFailure(source.position())).toBe("unchanged");
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(events.map((event) => event.type)).toEqual(["candidate_refused"]);
  });

  test("re-reading resets the order only when the contents change", async () => {
    const source = await rotating();
    const before = source.position();
    source.reportAuthenticationFailure(before);
    // Unchanged files (kubelet rewrites the same values): stays on current.
    await writeFile(current, NEW_PASSWORD);
    await writeFile(previous, OLD_PASSWORD);
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(source.candidateIndex).toBe(1);
    // The previous file is cleared after the rotation: one candidate, current.
    await writeFile(previous, "");
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(source.candidateCount).toBe(1);
    // A refusal reported for the old file contents changes nothing.
    source.reportAuthenticationFailure(before);
    expect(await source.password()).toBe(NEW_PASSWORD);
    // The next rotation writes new files: the order starts at previous again.
    const NEXT = ["next", "pw", "A1b"].join("-");
    await writeFile(previous, NEW_PASSWORD);
    await writeFile(current, NEXT);
    expect(await source.password()).toBe(NEW_PASSWORD);
    expect(source.candidateIndex).toBe(0);
    source.reportAuthenticationFailure(source.position());
    expect(await source.password()).toBe(NEXT);
  });

  test("a throwing observer never fails a connection attempt", async () => {
    await writeFile(current, NEW_PASSWORD);
    await writeFile(previous, OLD_PASSWORD);
    const source = new RotatingDatabasePassword({
      files: { currentPasswordFile: current, previousPasswordFile: previous },
      fallbackPassword: URL_PASSWORD,
      onEvent: () => {
        throw new Error("observer down");
      },
    });
    expect(await source.password()).toBe(OLD_PASSWORD);
    expect(() => source.reportAuthenticationFailure(source.position())).not.toThrow();
    expect(await source.password()).toBe(NEW_PASSWORD);
  });
});

describe("connection-layer retry", () => {
  test("a 28P01 is retried once on the next candidate, which then sticks", async () => {
    const valid = { password: OLD_PASSWORD };
    const db = server(valid);
    const source = await rotating();
    const query = () =>
      withDatabaseAuthenticationRetry(source, async () => db.connect(await source.password()));
    expect(await query()).toBe("ok");
    valid.password = NEW_PASSWORD; // the role's password changes
    expect(await query()).toBe("ok");
    expect(await query()).toBe("ok");
    expect(db.attempts).toEqual(["old", "old", "new", "new"]);
  });

  test("queued operations refused together switch once and all succeed", async () => {
    const db = server({ password: NEW_PASSWORD });
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withDatabaseAuthenticationRetry(source, async () => {
          // Every attempt reads the password before any refusal comes back.
          const password = await source.password();
          await Bun.sleep(1);
          return db.connect(password);
        }),
      ),
    );
    expect(results).toEqual(Array(8).fill("ok"));
    expect(events.filter((event) => event.type === "candidate_switched")).toHaveLength(1);
    expect(events.filter((event) => event.type === "candidates_exhausted")).toEqual([]);
  });

  test("a straggler after the switch retries on the selected candidate", async () => {
    const db = server({ password: NEW_PASSWORD });
    const source = await rotating();
    // Its login read the old password before another login's refusal moved
    // the pool, so its refusal arrives after the switch: stale.
    const straggler = {};
    const stalePassword = await source.password(straggler);
    source.reportAuthenticationFailure(source.position());
    let attempt = 0;
    const result = await withDatabaseAuthenticationRetry(source, async () => {
      if (attempt++ === 0) return db.connect(stalePassword, straggler);
      const login = {};
      return db.connect(await source.password(login), login);
    });
    expect(result).toBe("ok");
    expect(source.candidateIndex).toBe(1);
    expect(db.attempts).toEqual(["old", "new"]);
  });

  test("stale refusals do not use up the budget", async () => {
    const db = server({ password: NEW_PASSWORD });
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    // Three logins read the old password, then another login's refusal moved
    // the pool; this operation lands on all three before a fresh login.
    const stragglers = [{}, {}, {}];
    for (const login of stragglers) await source.password(login);
    source.reportAuthenticationFailure(source.position());
    let attempt = 0;
    const result = await withDatabaseAuthenticationRetry(source, async () => {
      const straggler = stragglers[attempt++];
      if (straggler) return db.connect(OLD_PASSWORD, straggler);
      const login = {};
      return db.connect(await source.password(login), login);
    });
    expect(result).toBe("ok");
    expect(attempt).toBe(4);
    expect(events.filter((event) => event.type === "candidates_exhausted")).toEqual([]);
  });

  test("stale refusals stop at the hard cap", async () => {
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    let attempts = 0;
    const outcome = await withDatabaseAuthenticationRetry(source, async () => {
      attempts += 1;
      // Every attempt's login reads a password, then another login's
      // refusal moves the pool before this one is refused.
      const login = {};
      await source.password(login);
      const other = {};
      await source.password(other);
      source.reportAuthenticationFailure(source.refusedPosition(refusedBy(other))!);
      throw refusedBy(login);
    }).catch((error: unknown) => error);
    expect(isDatabaseAuthenticationFailure(outcome)).toBe(true);
    expect(attempts).toBe(DATABASE_AUTHENTICATION_MAX_ATTEMPTS);
    expect(events.filter((event) => event.type === "candidates_exhausted")).toHaveLength(1);
  });

  test("attempts are bounded by the candidates and the last 28P01 surfaces unchanged", async () => {
    const events: DatabaseCredentialEvent[] = [];
    const source = await rotating(events);
    const errors: Error[] = [];
    const outcome = await withDatabaseAuthenticationRetry(source, async () => {
      const error = refused();
      errors.push(error);
      throw error;
    }).catch((error: unknown) => error);
    expect(errors).toHaveLength(2);
    expect(outcome).toBe(errors.at(-1)!);
    // Refused on both while selected: the pool switched twice, back to the first.
    expect(events.at(-1)).toEqual({ type: "candidates_exhausted", index: 0, candidates: 2 });
  });

  test("a single password fails fast: one attempt, no retry", async () => {
    await writeFile(current, NEW_PASSWORD);
    const source = credential();
    let attempts = 0;
    const failure = refused();
    const outcome = await withDatabaseAuthenticationRetry(source, async () => {
      attempts += 1;
      await source.password();
      throw failure;
    }).catch((error: unknown) => error);
    expect(outcome).toBe(failure);
    expect(attempts).toBe(1);
  });

  test("without password files there is no retry at all", async () => {
    const source = rotatingDatabasePasswordFor("postgres://u:p@h/db", undefined, undefined);
    let attempts = 0;
    const failure = refused();
    const outcome = await withDatabaseAuthenticationRetry(source, async () => {
      attempts += 1;
      throw failure;
    }).catch((error: unknown) => error);
    expect(outcome).toBe(failure);
    expect(attempts).toBe(1);
  });

  test("other errors are not retried", async () => {
    const source = await rotating();
    let attempts = 0;
    const failure = Object.assign(new Error("deadlock"), { code: "40P01" });
    const outcome = await withDatabaseAuthenticationRetry(source, async () => {
      attempts += 1;
      throw failure;
    }).catch((error: unknown) => error);
    expect(outcome).toBe(failure);
    expect(attempts).toBe(1);
    expect(source.candidateIndex).toBe(0);
  });

  test("a caller can veto a retry once its work started", async () => {
    const source = await rotating();
    let attempts = 0;
    const outcome = await withDatabaseAuthenticationRetry(
      source,
      async () => {
        attempts += 1;
        throw refused();
      },
      () => false,
    ).catch((error: unknown) => error);
    expect(isDatabaseAuthenticationFailure(outcome)).toBe(true);
    expect(attempts).toBe(1);
    expect(source.candidateIndex).toBe(0);
  });
});

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * A pool modeled on postgres.js's connection handling, against a server that
 * accepts exactly the role's current password. Each of `max` connections
 * logs in for the operation that opened it (its "initial" query); the next
 * queued operation waits for a free connection. A login asks for the
 * password only when the server requests it, passing its own identity as our
 * postgres.js patch does, and the server answers after the authentication
 * round trip against the role's password at that moment. A refusal rejects
 * only that login's operation, tagged with the login, and frees the
 * connection for the next queued operation's own login. Connections close
 * after one operation (lifetime churn), so every attempt logs in.
 */
class SimulatedPool {
  readonly events: DatabaseCredentialEvent[] = [];
  readonly source: RotatingDatabasePassword;
  /** While set, logins wait here between reading the password and the answer. */
  hold: Promise<void> | undefined;
  /** While set, logins wait here before asking for the password. */
  holdBeforeRead: Promise<void> | undefined;
  held = 0;
  #free: number;
  readonly #waiting: Array<() => void> = [];

  constructor(
    readonly role: { password: string },
    readonly max: number,
  ) {
    this.#free = max;
    this.source = credential(this.events);
  }

  operation(): Promise<"ok"> {
    return withDatabaseAuthenticationRetry(this.source, () => this.#login());
  }

  count(type: DatabaseCredentialEvent["type"], since = 0): number {
    return this.events.slice(since).filter((event) => event.type === type).length;
  }

  staleRefusals(since = 0): number {
    return this.events
      .slice(since)
      .filter((event) => event.type === "candidate_refused" && event.stale).length;
  }

  async #login(): Promise<"ok"> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      // TCP connect and startup until the server asks for the password.
      await Bun.sleep(Math.random() * 2);
      if (this.holdBeforeRead) await this.holdBeforeRead;
      const login = {};
      const password = await this.source.password(login);
      if (this.hold) {
        this.held += 1;
        await this.hold;
      }
      // The authentication round trip.
      await Bun.sleep(Math.random() * 2);
      if (password !== this.role.password) throw refusedBy(login);
      return "ok";
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

/** Several pools on the same files, as in one api and one worker pod. */
async function pools(role: { password: string }, sizes: number[]): Promise<SimulatedPool[]> {
  await writeFile(previous, `${OLD_PASSWORD}\n`);
  await writeFile(current, `${NEW_PASSWORD}\n`);
  const created = sizes.map((max) => new SimulatedPool(role, max));
  for (const pool of created) await pool.source.password();
  return created;
}

/**
 * Hold every connection of every pool between reading its password and the
 * server's answer, run `operations` per pool, change the role's password
 * while all those logins are in flight, then let them be answered.
 */
async function switchUnderConcurrentLogins(
  all: SimulatedPool[],
  role: { password: string },
  rolePassword: string,
  operations: number,
) {
  const inFlight = gate();
  for (const pool of all) {
    pool.held = 0;
    pool.hold = inFlight.promise;
  }
  const outcomes = Promise.allSettled(
    all.map((pool) =>
      Promise.allSettled(Array.from({ length: operations }, () => pool.operation())),
    ),
  );
  const everyConnection = all.reduce((sum, pool) => sum + pool.max, 0);
  while (all.reduce((sum, pool) => sum + pool.held, 0) < everyConnection) await Bun.sleep(1);
  role.password = rolePassword;
  for (const pool of all) pool.hold = undefined;
  inFlight.open();
  const settled = await outcomes;
  return settled.map((outcome) =>
    outcome.status === "fulfilled"
      ? outcome.value.filter((result) => result.status === "rejected").length
      : Number.NaN,
  );
}

describe("concurrent logins at the moment of a switch", () => {
  const SIZES = [8, 4, 2, 1];

  test("forward: every in-flight login is refused, the pool switches once, no operation fails", async () => {
    const role = { password: OLD_PASSWORD };
    const all = await pools(role, SIZES);
    const failed = await switchUnderConcurrentLogins(all, role, NEW_PASSWORD, 40);
    expect(failed).toEqual(SIZES.map(() => 0));
    for (const pool of all) {
      // One refused login per connection that was logging in with the old
      // password; the first moved the pool, the others were stale.
      expect(pool.count("candidate_refused")).toBe(pool.max);
      expect(pool.staleRefusals()).toBe(pool.max - 1);
      expect(pool.count("candidate_switched")).toBe(1);
      expect(pool.count("candidates_exhausted")).toBe(0);
      expect(pool.source.candidateIndex).toBe(1);
    }
  });

  test("mirrored rollback right after the switch: the pool switches back at once, no operation fails", async () => {
    // The forward rotation just happened: the role has the new password and
    // every pool switched to it moments ago.
    const role = { password: NEW_PASSWORD };
    const all = await pools(role, SIZES);
    for (const pool of all) pool.source.reportAuthenticationFailure(pool.source.position());
    const marks = all.map((pool) => pool.events.length);
    // The rollback restores the old password while every connection is
    // logging in with the new one.
    const failed = await switchUnderConcurrentLogins(all, role, OLD_PASSWORD, 40);
    expect(failed).toEqual(SIZES.map(() => 0));
    all.forEach((pool, index) => {
      const since = marks[index]!;
      expect(pool.count("candidate_refused", since)).toBe(pool.max);
      expect(pool.staleRefusals(since)).toBe(pool.max - 1);
      expect(pool.count("candidate_switched", since)).toBe(1);
      expect(pool.count("candidates_exhausted")).toBe(0);
      expect(pool.source.candidateIndex).toBe(0);
    });
  });

  test("a pool that switched on a refusal of a valid password switches back immediately", async () => {
    // The role never changed, but the pool moved to the new password (as a
    // misattributed stale refusal used to do). The first refusal of the new
    // password must move it back at once, with every operation succeeding.
    const role = { password: OLD_PASSWORD };
    const all = await pools(role, SIZES);
    for (const pool of all) pool.source.reportAuthenticationFailure(pool.source.position());
    const marks = all.map((pool) => pool.events.length);
    const failed = await switchUnderConcurrentLogins(all, role, OLD_PASSWORD, 40);
    expect(failed).toEqual(SIZES.map(() => 0));
    all.forEach((pool, index) => {
      expect(pool.count("candidate_switched", marks[index]!)).toBe(1);
      expect(pool.count("candidate_refused", marks[index]!)).toBe(pool.max);
      expect(pool.count("candidates_exhausted")).toBe(0);
      expect(pool.source.candidateIndex).toBe(0);
    });
  });

  test("a refusal counts for the password its login used, not the one selected when the operation started", async () => {
    // The operation starts on the old password, which the role accepts; its
    // login asks for the password only after the pool moved to the new one.
    const role = { password: OLD_PASSWORD };
    const [pool] = await pools(role, [1]);
    const beforeRead = gate();
    pool!.holdBeforeRead = beforeRead.promise;
    const operation = pool!.operation();
    await Bun.sleep(5);
    pool!.source.reportAuthenticationFailure(pool!.source.position());
    const mark = pool!.events.length;
    pool!.holdBeforeRead = undefined;
    beforeRead.open();
    expect(await operation).toBe("ok");
    // The refusal of the new password was fresh: one switch back, no stale
    // refusal, and the retry on the old password succeeded.
    expect(pool!.count("candidate_refused", mark)).toBe(1);
    expect(pool!.staleRefusals(mark)).toBe(0);
    expect(pool!.count("candidate_switched", mark)).toBe(1);
    expect(pool!.count("candidates_exhausted")).toBe(0);
    expect(pool!.source.candidateIndex).toBe(0);
  });

  test("a forward rotation and a quick rollback under continuous load fail no operation", async () => {
    const role = { password: OLD_PASSWORD };
    const all = await pools(role, SIZES);
    const running = { value: true };
    let completed = 0;
    const failures: unknown[] = [];
    const lanes = all.flatMap((pool) =>
      Array.from({ length: pool.max * 3 }, async () => {
        while (running.value) {
          await pool.operation().then(
            () => (completed += 1),
            (error: unknown) => failures.push(error),
          );
        }
      }),
    );
    await Bun.sleep(50);
    role.password = NEW_PASSWORD;
    await Bun.sleep(150);
    role.password = OLD_PASSWORD;
    await Bun.sleep(150);
    running.value = false;
    await Promise.all(lanes);
    expect(failures).toEqual([]);
    expect(completed).toBeGreaterThan(100);
    for (const pool of all) {
      expect(pool.count("candidates_exhausted")).toBe(0);
      // Forward, then back: every pool ends on the old password.
      expect(pool.count("candidate_switched")).toBe(2);
      expect(pool.source.candidateIndex).toBe(0);
    }
  });

  test("rollback by reversing the files: the reload selects the server's password, then one switch when the server reverts", async () => {
    // Forward rotation: files previous=old, current=new; the server moves to
    // new while every connection is logging in with old.
    const role = { password: OLD_PASSWORD };
    const all = await pools(role, SIZES);
    expect(await switchUnderConcurrentLogins(all, role, NEW_PASSWORD, 20)).toEqual(
      SIZES.map(() => 0),
    );
    // The mirrored rollback reverses the files (previous=new, current=old;
    // previous first, so no read ever sees only the old password while the
    // server still has the new one) and waits for every pool to see them.
    await writeFile(previous, `${NEW_PASSWORD}\n`);
    await writeFile(current, `${OLD_PASSWORD}\n`);
    for (const pool of all) {
      await pool.source.password();
      // The reload restarts at the first candidate, which is now new: the
      // password the server still has, so nothing is refused yet.
      expect(pool.source.candidateIndex).toBe(0);
      expect(pool.source.candidateCount).toBe(2);
    }
    const marks = all.map((pool) => pool.events.length);
    const quiet = await Promise.all(all.map((pool) => pool.operation()));
    expect(quiet.every((result) => result === "ok")).toBe(true);
    all.forEach((pool, index) => expect(pool.count("candidate_refused", marks[index]!)).toBe(0));
    // Then the server is restored to old with every connection logging in.
    const failed = await switchUnderConcurrentLogins(all, role, OLD_PASSWORD, 40);
    expect(failed).toEqual(SIZES.map(() => 0));
    all.forEach((pool, index) => {
      const since = marks[index]!;
      expect(pool.count("candidate_refused", since)).toBe(pool.max);
      expect(pool.staleRefusals(since)).toBe(pool.max - 1);
      expect(pool.count("candidate_switched", since)).toBe(1);
      expect(pool.count("candidates_exhausted")).toBe(0);
      expect(pool.source.candidateIndex).toBe(1);
    });
  });

  test("forward rotation, file reversal and server rollback under continuous load fail no operation", async () => {
    const role = { password: OLD_PASSWORD };
    const all = await pools(role, SIZES);
    const running = { value: true };
    let completed = 0;
    const failures: unknown[] = [];
    const lanes = all.flatMap((pool) =>
      Array.from({ length: pool.max * 3 }, async () => {
        while (running.value) {
          await pool.operation().then(
            () => (completed += 1),
            (error: unknown) => failures.push(error),
          );
        }
      }),
    );
    await Bun.sleep(50);
    role.password = NEW_PASSWORD;
    await Bun.sleep(150);
    await writeFile(previous, `${NEW_PASSWORD}\n`);
    await writeFile(current, `${OLD_PASSWORD}\n`);
    await Bun.sleep(150);
    role.password = OLD_PASSWORD;
    await Bun.sleep(150);
    running.value = false;
    await Promise.all(lanes);
    expect(failures).toEqual([]);
    expect(completed).toBeGreaterThan(100);
    for (const pool of all) {
      expect(pool.count("candidates_exhausted")).toBe(0);
      // One switch forward; the reversal itself reselects new without a
      // switch; one switch when the server returns to old.
      expect(pool.count("candidate_switched")).toBe(2);
      expect(pool.source.candidateIndex).toBe(1);
    }
  });

  test("a single configured password still fails fast for every concurrent operation", async () => {
    await writeFile(current, NEW_PASSWORD);
    const role = { password: OLD_PASSWORD };
    const pool = new SimulatedPool(role, 4);
    await pool.source.password();
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => pool.operation()));
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    for (const outcome of outcomes) {
      expect(isDatabaseAuthenticationFailure((outcome as PromiseRejectedResult).reason)).toBe(true);
    }
    // One login per operation: no retry, no switch, no exhausted event.
    expect(pool.count("candidate_refused")).toBe(12);
    expect(pool.count("candidate_switched")).toBe(0);
    expect(pool.count("candidates_exhausted")).toBe(0);
  });
});

describe("no secret in events, logs or errors", () => {
  test("events and the default log lines carry indexes only", async () => {
    await writeFile(current, NEW_PASSWORD);
    await writeFile(previous, OLD_PASSWORD);
    const lines: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args);
    try {
      const events: DatabaseCredentialEvent[] = [];
      const log = logDatabaseCredentialEvent("test-pool");
      const source = new RotatingDatabasePassword({
        files: { currentPasswordFile: current, previousPasswordFile: previous },
        fallbackPassword: URL_PASSWORD,
        onEvent: (event) => {
          events.push(event);
          log(event);
        },
      });
      await source.password();
      source.reportAuthenticationFailure(source.position());
      const outcome = await withDatabaseAuthenticationRetry(source, async () => {
        const login = {};
        await source.password(login);
        throw refusedBy(login);
      }).catch((error: unknown) => error);
      await writeFile(previous, "");
      await source.password();
      expectNoSecret(events);
      expectNoSecret(lines.map((line) => line.map((part) => JSON.stringify(part)).join(" ")));
      expectNoSecret(String(outcome));
      expectNoSecret((outcome as Error).stack ?? "");
      // Every event is logged. The retry is refused on the selected password
      // each time, so the pool moves on twice before every candidate was
      // refused.
      expect(lines.map((line) => line[0])).toEqual([
        "[database] reloaded database credential candidates",
        "[database] database credential candidate refused",
        "[database] switched database credential candidate",
        "[database] database credential candidate refused",
        "[database] switched database credential candidate",
        "[database] database credential candidate refused",
        "[database] switched database credential candidate",
        "[database] every database credential candidate was rejected",
        "[database] reloaded database credential candidates",
      ]);
      expect(lines[0]?.[1]).toEqual({ databasePool: "test-pool", credentialCandidates: 2 });
      expect(lines[1]?.[1]).toEqual({
        databasePool: "test-pool",
        credentialIndex: 0,
        credentialCandidates: 2,
        credentialStale: false,
      });
      expect(lines[2]?.[1]).toEqual({
        databasePool: "test-pool",
        credentialFromIndex: 0,
        credentialToIndex: 1,
        credentialCandidates: 2,
      });
      expect(lines[7]?.[1]).toEqual({
        databasePool: "test-pool",
        credentialIndex: 1,
        credentialCandidates: 2,
      });
      // The object itself does not expose a password through serialization.
      expectNoSecret(source);
      expectNoSecret(String(source));
    } finally {
      console.warn = original;
    }
  });

  test("the LISTEN connection is tagged in log lines", () => {
    const lines: Array<[string, Record<string, string | number | boolean>]> = [];
    logDatabaseCredentialEvent("api", (message, attributes) => lines.push([message, attributes]))(
      { type: "candidate_switched", fromIndex: 0, toIndex: 1, candidates: 2 },
      "notifications",
    );
    expect(lines[0]?.[1].databasePool).toBe("api-notifications");
  });

  test("an unreadable file is logged by file and errno code only", () => {
    expect(
      databaseCredentialEventAttributes("worker", {
        type: "password_file_unreadable",
        file: "previous",
        code: "EACCES",
      }),
    ).toEqual({
      databasePool: "worker",
      credentialFile: "previous",
      credentialFileErrorCode: "EACCES",
    });
  });
});

describe("credential event metrics and structured logs", () => {
  function recordingObserver() {
    const counters: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
    const warnings: Array<[string, Record<string, string | number | boolean>]> = [];
    return {
      counters,
      warnings,
      observer: {
        warn: (message: string, attributes: Record<string, string | number | boolean>) =>
          void warnings.push([message, attributes]),
        incrementCounter: (input: { name: string; labels?: Record<string, string> }) =>
          void counters.push({ name: input.name, labels: input.labels }),
      },
    };
  }

  test("refusals (stale or fresh), switches, exhaustions and reloads are counted by pool and index", () => {
    const { counters, warnings, observer } = recordingObserver();
    const listen = observeDatabaseCredentialEvents("worker", observer);
    listen({ type: "candidates_reloaded", candidates: 2 }, "pool");
    listen({ type: "candidate_refused", index: 0, candidates: 2, stale: false }, "pool");
    listen({ type: "candidate_switched", fromIndex: 0, toIndex: 1, candidates: 2 }, "pool");
    listen({ type: "candidate_refused", index: 0, candidates: 2, stale: true }, "pool");
    listen({ type: "candidates_exhausted", index: 1, candidates: 2 }, "notifications");
    listen({ type: "password_file_unreadable", file: "current", code: "EACCES" }, "pool");
    expect(counters).toEqual([
      {
        name: "opengeni_database_credential_reloads_total",
        labels: { pool: "worker", candidates: "2" },
      },
      {
        name: "opengeni_database_credential_refusals_total",
        labels: { pool: "worker", index: "0", refusal: "fresh" },
      },
      {
        name: "opengeni_database_credential_switches_total",
        labels: { pool: "worker", from_index: "0", to_index: "1" },
      },
      {
        name: "opengeni_database_credential_refusals_total",
        labels: { pool: "worker", index: "0", refusal: "stale" },
      },
      {
        name: "opengeni_database_credential_exhaustions_total",
        labels: { pool: "worker-notifications", index: "1" },
      },
    ]);
    expect(DATABASE_CREDENTIAL_METRICS.refusals.name).toBe(
      "opengeni_database_credential_refusals_total",
    );
    // Every event is also logged, with the pool and its facts.
    expect(warnings.map(([message]) => message)).toEqual([
      "reloaded database credential candidates",
      "database credential candidate refused",
      "switched database credential candidate",
      "database credential candidate refused",
      "every database credential candidate was rejected",
      "database password file unreadable; treating it as missing",
    ]);
    expect(warnings[3]?.[1]).toEqual({
      databasePool: "worker",
      credentialIndex: 0,
      credentialCandidates: 2,
      credentialStale: true,
    });
    expect(warnings[4]?.[1].databasePool).toBe("worker-notifications");
  });

  test("a failing observer never reaches the pool", async () => {
    await writeFile(previous, OLD_PASSWORD);
    await writeFile(current, NEW_PASSWORD);
    const source = new RotatingDatabasePassword({
      files: { currentPasswordFile: current, previousPasswordFile: previous },
      fallbackPassword: URL_PASSWORD,
      onEvent: observeDatabaseCredentialEvents("worker", {
        warn: () => {
          throw new Error("log sink down");
        },
        incrementCounter: () => {
          throw new Error("registry conflict");
        },
      }),
    });
    expect(await source.password()).toBe(OLD_PASSWORD);
    expect(source.reportAuthenticationFailure(source.position())).toBe("switched");
    expect(await source.password()).toBe(NEW_PASSWORD);
  });

  test("a real Observability publishes the pool and index on log lines and as Prometheus counters", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (line: string) => void lines.push(String(line));
    console.warn = (line: string) => void lines.push(String(line));
    try {
      const observability = createObservability(
        {
          observabilityStructuredLogs: true,
          observabilityMetricsEnabled: true,
          serviceName: "opengeni-worker",
          environment: "test",
        } as never,
        { component: "worker" },
      );
      await writeFile(previous, `${OLD_PASSWORD}\n`);
      await writeFile(current, `${NEW_PASSWORD}\n`);
      const source = new RotatingDatabasePassword({
        files: { currentPasswordFile: current, previousPasswordFile: previous },
        fallbackPassword: URL_PASSWORD,
        onEvent: observeDatabaseCredentialEvents("worker-control", observability),
      });
      await source.password();
      // Three logins in flight with the old password when the server moves to
      // the new one: one fresh refusal (the switch), two stale ones.
      const logins = [{}, {}, {}];
      for (const login of logins) await source.password(login);
      for (const login of logins) {
        source.reportAuthenticationFailure(source.refusedPosition(refusedBy(login))!);
      }
      const metrics = await observability.prometheusMetrics();
      // The registry appends its default labels (service, component, ...).
      const sample = (name: string, labels: string) =>
        metrics
          .split("\n")
          .find((line) => line.startsWith(`${name}{${labels},`))
          ?.split(" ")
          .at(-1);
      expect(
        sample(
          "opengeni_database_credential_refusals_total",
          'index="0",pool="worker-control",refusal="fresh"',
        ),
      ).toBe("1");
      expect(
        sample(
          "opengeni_database_credential_refusals_total",
          'index="0",pool="worker-control",refusal="stale"',
        ),
      ).toBe("2");
      expect(
        sample(
          "opengeni_database_credential_switches_total",
          'from_index="0",pool="worker-control",to_index="1"',
        ),
      ).toBe("1");
      expect(
        sample(
          "opengeni_database_credential_reloads_total",
          'candidates="2",pool="worker-control"',
        ),
      ).toBe("1");
      expectNoSecret(metrics);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    expectNoSecret(lines);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const switched = records.find(
      (record) => record.message === "switched database credential candidate",
    );
    expect(switched).toMatchObject({
      level: "warn",
      databasePool: "worker-control",
      credentialFromIndex: 0,
      credentialToIndex: 1,
      credentialCandidates: 2,
    });
    const stale = records.filter(
      (record) =>
        record.message === "database credential candidate refused" &&
        record.credentialStale === true,
    );
    expect(stale).toHaveLength(2);
    expect(stale[0]).toMatchObject({ databasePool: "worker-control", credentialIndex: 0 });
  });
});

describe("database URL helpers", () => {
  test("read the URL password and user the way postgres.js does", () => {
    expect(databaseUrlPassword("postgres://app:p%40ss@db:5432/x")).toBe("p@ss");
    expect(databaseUrlPassword("postgres://app@db/x", { PGPASSWORD: "env" })).toBe("env");
    expect(databaseUrlPassword("postgres://db/x", {})).toBe("");
    // An unencoded "@" in the password: postgres.js splits at the last "@".
    expect(databaseUrlPassword("postgres://app:p@ss@db/x", {})).toBe("p@ss");
    expect(databaseUrlPassword("postgres://app:pw@db1,db2/x", {})).toBe("pw");
    expect(databaseUrlUser("postgres://opengeni_app:p@db/x")).toBe("opengeni_app");
    expect(databaseUrlUser("postgres://db/x")).toBe(null);
  });

  test("recognizes 28P01 directly, nested, and on typed details", () => {
    expect(isDatabaseAuthenticationFailure({ code: "28P01" })).toBe(true);
    expect(isDatabaseAuthenticationFailure(new Error("x", { cause: { code: "28P01" } }))).toBe(
      true,
    );
    expect(isDatabaseAuthenticationFailure({ details: { sqlState: "28P01" } })).toBe(true);
    expect(isDatabaseAuthenticationFailure({ code: "28000" })).toBe(false);
    expect(isDatabaseAuthenticationFailure({ code: "57P01" })).toBe(false);
    expect(isDatabaseAuthenticationFailure(null)).toBe(false);
  });
});
