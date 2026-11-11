import { relative, resolve } from "node:path";
import { appendFileSync } from "node:fs";
import entries from "../quarantine.json" with { type: "json" };

/**
 * A known-flaky test that still runs everywhere but whose failure does not
 * fail its lane. Each entry names a tracking issue; remove the entry when
 * that issue is fixed. See docs/testing-quarantine.md.
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
};

export const QUARANTINE: readonly QuarantineEntry[] = entries;

const repositoryRoot = resolve(import.meta.dir, "../../..");

export function quarantineEntry(testFile: string, title: string): QuarantineEntry | undefined {
  const file = relative(repositoryRoot, resolve(testFile)).split("\\").join("/");
  return QUARANTINE.find((entry) => entry.file === file && entry.test === title);
}

/** `enforce` makes quarantined failures fail again, for example while fixing one. */
export function quarantineEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENGENI_TEST_QUARANTINE === "enforce";
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
  options: { deadlineMs?: number } = {},
): (...args: Args) => unknown {
  const entry = quarantineEntry(testFile, title);
  if (!entry || quarantineEnforced()) return body;
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
  options: { deadlineMs?: number } = {},
): Registrar {
  return new Proxy(base, {
    apply(target, thisArg, args: unknown[]) {
      const [title, body, ...rest] = args;
      if (
        typeof title === "string" &&
        typeof body === "function" &&
        quarantineEntry(testFile, title)
      ) {
        if (body.length > 0) {
          throw new Error(`a quarantined test cannot use a done callback: ${title}`);
        }
        const wrapped = quarantinable(testFile, title, body as () => unknown, options);
        return Reflect.apply(target, thisArg, [title, wrapped, ...rest]);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
