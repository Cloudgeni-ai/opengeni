import { relative, resolve } from "node:path";
import { appendFileSync } from "node:fs";
import entries from "../quarantine.json" with { type: "json" };

/**
 * A known-flaky test that still runs everywhere but whose failure does not
 * fail its lane, until its `expires` date. Each entry names a tracking issue;
 * remove the entry when that issue is fixed. See docs/testing-quarantine.md.
 */
export type QuarantineEntry = {
  /** Repository-relative test file. */
  file: string;
  /** The test's own title, as passed to test() (without describe() prefixes). */
  test: string;
  /** Tracking issue for the fix. */
  issue: string;
  /** What fails and why it is quarantined rather than fixed. */
  reason: string;
  /** The day (YYYY-MM-DD, UTC) the entry was added or last renewed. */
  added: string;
  /**
   * The last day (YYYY-MM-DD, UTC) the quarantine holds, at most
   * QUARANTINE_MAX_DAYS after `added`. From the next day the test fails
   * normally again.
   */
  expires: string;
};

export const QUARANTINE: readonly QuarantineEntry[] = entries;

/** The longest an entry may quarantine a test before it is fixed or renewed. */
export const QUARANTINE_MAX_DAYS = 30;

export type QuarantineOptions = {
  /** Report a body still running after this many milliseconds as a failure and end the test. */
  deadlineMs?: number;
  /** The list to consult; the checked-in list by default. */
  entries?: readonly QuarantineEntry[];
  /** The current time, for expiry; the clock by default. */
  now?: () => Date;
};

const repositoryRoot = resolve(import.meta.dir, "../../..");

export function quarantineEntry(
  testFile: string,
  title: string,
  list: readonly QuarantineEntry[] = QUARANTINE,
): QuarantineEntry | undefined {
  const file = relative(repositoryRoot, resolve(testFile)).split("\\").join("/");
  return list.find((entry) => entry.file === file && entry.test === title);
}

/** `enforce` makes quarantined failures fail again, for example while fixing one. */
export function quarantineEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENGENI_TEST_QUARANTINE === "enforce";
}

/** Whether the entry's last day has passed, so its test fails normally again. */
export function quarantineExpired(entry: QuarantineEntry, now: Date = new Date()): boolean {
  const lastMoment = Date.parse(`${entry.expires}T23:59:59.999Z`);
  // An unreadable date counts as expired: the test fails normally.
  return !(lastMoment >= now.getTime());
}

const reportedExpired = new Set<QuarantineEntry>();

function reportExpired(entry: QuarantineEntry): void {
  if (reportedExpired.has(entry)) return;
  reportedExpired.add(entry);
  console.log(
    `::warning title=Test quarantine expired::${entry.file}: ${entry.test} expired on ${entry.expires} and fails normally again; fix it or renew the entry (${entry.issue})`,
  );
}

function reportQuarantinedFailure(entry: QuarantineEntry, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // Keep the full failure in the log, and surface it as a CI annotation.
  console.error(`[quarantine] ${entry.file}: ${entry.test} failed (${entry.issue})\n${detail}`);
  console.log(
    `::warning title=Quarantined test failed::${entry.file}: ${entry.test} (${entry.issue})`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(
        summary,
        `- Quarantined test failed: \`${entry.file}\`: ${entry.test} ([tracking issue](${entry.issue}))\n`,
      );
    } catch {
      // The annotation and log above already report it.
    }
  }
}

/**
 * Wraps a test body so that, when the test is listed in quarantine.json, a
 * failure is reported (log, CI annotation and step summary) instead of
 * failing the run. Unlisted tests, and every test under
 * OPENGENI_TEST_QUARANTINE=enforce, get their body back unchanged.
 *
 *   test(title, quarantinable(import.meta.path, title, async () => { ... }), 90_000);
 *
 * Only failures thrown by the body are absorbed; a failing hook still fails.
 * A body that can hang needs `deadlineMs` below the test's own timeout: once
 * the deadline passes the hang is reported like a failure and the test ends
 * (the hung work is abandoned, not cancelled).
 */
export function quarantinable<Args extends unknown[]>(
  testFile: string,
  title: string,
  body: (...args: Args) => unknown,
  options: QuarantineOptions = {},
): (...args: Args) => unknown {
  const entry = quarantineEntry(testFile, title, options.entries);
  if (!entry || quarantineEnforced()) return body;
  if (quarantineExpired(entry, options.now?.() ?? new Date())) {
    reportExpired(entry);
    return body;
  }
  return async (...args: Args) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = Promise.resolve().then(() => body(...args));
      if (options.deadlineMs === undefined) {
        await run;
      } else {
        const deadlineMs = options.deadlineMs;
        // A body abandoned at the deadline may still reject later; that must
        // not surface as an unhandled error in a later test.
        run.catch(() => undefined);
        await Promise.race([
          run,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`did not finish within ${deadlineMs} ms`)),
              deadlineMs,
            );
          }),
        ]);
      }
    } catch (error) {
      reportQuarantinedFailure(entry, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Rebinds `test` (or a conditional alias of it) in a file that has
 * quarantined tests, so call sites stay unchanged. Every call goes straight to
 * `base` unless quarantine.json lists its title; `test.skip`, `test.each` and
 * the rest are `base`'s own.
 *
 *   import { test as bunTest } from "bun:test";
 *   const test = quarantineTest(bunTest, import.meta.path);
 */
export function quarantineTest<Registrar extends (...args: never[]) => unknown>(
  base: Registrar,
  testFile: string,
  options: QuarantineOptions = {},
): Registrar {
  return new Proxy(base, {
    apply(target, thisArg, args: unknown[]) {
      const [title, body, ...rest] = args;
      if (
        typeof title === "string" &&
        typeof body === "function" &&
        quarantineEntry(testFile, title, options.entries)
      ) {
        if (body.length > 0) {
          throw new Error(`a quarantined test cannot use a done callback: ${title}`);
        }
        const wrapped = quarantinable(testFile, title, body as () => unknown, options);
        return Reflect.apply(target, thisArg, [title, wrapped, ...rest]);
      }
      return Reflect.apply(target, thisArg, args);
    },
    // bun's `test.skip`, `test.each` and the rest are native getters and
    // methods that only accept the real `test` as their receiver: read
    // getters from it, and call methods on it.
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !isMethod(target, property)) return value;
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  });
}

/** Whether `property` is a plain data property (not a getter) on `target` or its prototypes. */
function isMethod(target: object, property: PropertyKey): boolean {
  for (let owner: object | null = target; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (descriptor) return "value" in descriptor;
  }
  return false;
}
