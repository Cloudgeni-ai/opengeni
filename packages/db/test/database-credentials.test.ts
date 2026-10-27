import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS,
  databasePasswordFileOptions,
  databasePasswordFileOptionsFromEnvironment,
  databaseUrlPassword,
  databaseUrlUser,
  isDatabaseAuthenticationFailure,
  logDatabaseCredentialEvent,
  RotatingDatabasePassword,
  rotatingDatabasePasswordFor,
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

function credential(events: DatabaseCredentialEvent[] = [], now: () => number = () => 1_000) {
  return new RotatingDatabasePassword({
    files: { currentPasswordFile: current, previousPasswordFile: previous },
    fallbackPassword: URL_PASSWORD,
    onEvent: (event) => events.push(event),
    now,
  });
}

async function rotating(events: DatabaseCredentialEvent[] = [], now?: () => number) {
  await writeFile(previous, `${OLD_PASSWORD}\n`);
  await writeFile(current, `${NEW_PASSWORD}\n`);
  const source = credential(events, now);
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

/** A fake server that accepts exactly one password, like PostgreSQL. */
function server(valid: { password: string }) {
  const attempts: string[] = [];
  return {
    attempts,
    connect: async (password: string) => {
      attempts.push(password === OLD_PASSWORD ? "old" : password === NEW_PASSWORD ? "new" : "?");
      if (password !== valid.password) throw refused();
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

  test("a straggler refused just after the switch does not move the pool back", async () => {
    let now = 10_000;
    const source = await rotating([], () => now);
    source.reportAuthenticationFailure(source.position());
    now += DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS - 1;
    source.reportAuthenticationFailure(source.position());
    expect(await source.password()).toBe(NEW_PASSWORD);
  });

  test("after the grace a refusal of current wraps back to previous", async () => {
    // For example a release re-provisioned the role with the old password.
    let now = 10_000;
    const source = await rotating([], () => now);
    source.reportAuthenticationFailure(source.position());
    now += DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS;
    source.reportAuthenticationFailure(source.position());
    expect(await source.password()).toBe(OLD_PASSWORD);
  });

  test("a single candidate never switches", async () => {
    await writeFile(current, NEW_PASSWORD);
    const events: DatabaseCredentialEvent[] = [];
    const source = credential(events);
    await source.password();
    source.reportAuthenticationFailure(source.position());
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
    source.reportAuthenticationFailure(source.position());
    let attempt = 0;
    // Its first connection had read the old password before the switch.
    const result = await withDatabaseAuthenticationRetry(source, async () =>
      db.connect(attempt++ === 0 ? OLD_PASSWORD : await source.password()),
    );
    expect(result).toBe("ok");
    expect(source.candidateIndex).toBe(1);
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
    expect(events.at(-1)).toEqual({ type: "candidates_exhausted", index: 1, candidates: 2 });
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
        await source.password();
        throw refused();
      }).catch((error: unknown) => error);
      await writeFile(previous, "");
      await source.password();
      expectNoSecret(events);
      expectNoSecret(lines.map((line) => line.map((part) => JSON.stringify(part)).join(" ")));
      expectNoSecret(String(outcome));
      expectNoSecret((outcome as Error).stack ?? "");
      // Single refusals are not logged; switches, exhaustion and reloads are.
      expect(lines.map((line) => line[0])).toEqual([
        "[database] reloaded database credential candidates",
        "[database] switched database credential candidate",
        "[database] every database credential candidate was rejected",
        "[database] reloaded database credential candidates",
      ]);
      expect(lines[1]?.[1]).toEqual({ pool: "test-pool", fromIndex: 0, toIndex: 1, candidates: 2 });
      // The object itself does not expose a password through serialization.
      expectNoSecret(source);
      expectNoSecret(String(source));
    } finally {
      console.warn = original;
    }
  });

  test("the LISTEN connection is tagged in log lines", () => {
    const lines: Array<[string, Record<string, string | number>]> = [];
    logDatabaseCredentialEvent("api", (message, attributes) => lines.push([message, attributes]))(
      { type: "candidate_switched", fromIndex: 0, toIndex: 1, candidates: 2 },
      "notifications",
    );
    expect(lines[0]?.[1].pool).toBe("api-notifications");
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
