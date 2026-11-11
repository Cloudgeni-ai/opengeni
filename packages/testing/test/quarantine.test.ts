import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  QUARANTINE,
  QUARANTINE_MAX_DAYS,
  quarantinable,
  quarantineEnforced,
  quarantineEntry,
  quarantineExpired,
  quarantineTest,
} from "../src/quarantine";

const repositoryRoot = resolve(import.meta.dir, "../../..");

/** Whether `source` declares `title`, literally or as a template title such as `... at ${width}px`. */
function declaresTitle(source: string, title: string): boolean {
  if (source.includes(JSON.stringify(title)) || source.includes(`\`${title}\``)) return true;
  for (const match of source.matchAll(/`([^`$]{12,})\$\{/g)) {
    if (title.startsWith(match[1]!)) return true;
  }
  return false;
}

describe("quarantine list", () => {
  test("every entry points at a test that still exists and is registered through quarantineTest", () => {
    for (const entry of QUARANTINE) {
      const path = resolve(repositoryRoot, entry.file);
      expect(existsSync(path), entry.file).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(declaresTitle(source, entry.test), `${entry.file}: ${entry.test}`).toBe(true);
      expect(source, entry.file).toContain("quarantineTest(");
    }
  });

  test("every entry has a tracking issue and a reason, and none is listed twice", () => {
    const keys = new Set<string>();
    for (const entry of QUARANTINE) {
      // The repository is public, so the tracking issue must be one anyone can open.
      expect(entry.issue).toMatch(/^https:\/\/github\.com\/Cloudgeni-ai\/opengeni\/issues\/\d+$/);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      const key = `${entry.file}\u0000${entry.test}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
    }
  });

  test("every entry ends at most QUARANTINE_MAX_DAYS after it was added or renewed", () => {
    // Only the window is checked, never today's date against `expires`: an
    // expired entry makes its own test fail again, not this check.
    const day = /^\d{4}-\d{2}-\d{2}$/u;
    for (const entry of QUARANTINE) {
      const label = `${entry.file}: ${entry.test}`;
      expect(entry.added, label).toMatch(day);
      expect(entry.expires, label).toMatch(day);
      const added = Date.parse(`${entry.added}T00:00:00Z`);
      const expires = Date.parse(`${entry.expires}T00:00:00Z`);
      expect(Number.isNaN(added) || Number.isNaN(expires), label).toBe(false);
      expect(added, `${label}: added is in the future`).toBeLessThanOrEqual(Date.now());
      const days = (expires - added) / 86_400_000;
      expect(days, label).toBeGreaterThanOrEqual(0);
      expect(days, label).toBeLessThanOrEqual(QUARANTINE_MAX_DAYS);
    }
  });
});

describe("quarantinable", () => {
  // A synthetic entry, so these checks hold whatever the checked-in list holds and whenever they run.
  const listedFile = import.meta.path;
  const listed = {
    file: relative(repositoryRoot, listedFile).split("\\").join("/"),
    test: "a flaky case",
    issue: "https://github.com/Cloudgeni-ai/opengeni/issues/1",
    reason: "Fails now and then.",
    added: "2026-01-10",
    expires: "2026-01-20",
  };
  const list = [listed];
  const active = { entries: list, now: () => new Date("2026-01-15T12:00:00Z") };

  test("matches entries by repository-relative file and exact title", () => {
    expect(quarantineEntry(listedFile, listed.test, list)).toBe(listed);
    expect(quarantineEntry(listedFile, `${listed.test} (another case)`, list)).toBeUndefined();
    expect(
      quarantineEntry(resolve(repositoryRoot, "nope.test.ts"), listed.test, list),
    ).toBeUndefined();
  });

  test("a listed failure is reported instead of failing", async () => {
    const errors: unknown[] = [];
    const logs: unknown[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await quarantinable(
        listedFile,
        listed.test,
        () => {
          throw new Error("flaked");
        },
        active,
      )();
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(String(errors[0])).toContain("flaked");
    expect(String(errors[0])).toContain(listed.issue);
    expect(String(logs[0])).toStartWith("::warning title=Quarantined test failed::");
  });

  test("an unlisted test keeps its body, so a failure still fails", async () => {
    const body = () => {
      throw new Error("real failure");
    };
    expect(quarantinable(listedFile, "an unlisted test", body, active)).toBe(body);
  });

  test("enforce mode fails listed tests again", () => {
    const body = () => undefined;
    const previous = process.env.OPENGENI_TEST_QUARANTINE;
    process.env.OPENGENI_TEST_QUARANTINE = "enforce";
    try {
      expect(quarantineEnforced()).toBe(true);
      expect(quarantinable(listedFile, listed.test, body, active)).toBe(body);
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_TEST_QUARANTINE;
      else process.env.OPENGENI_TEST_QUARANTINE = previous;
    }
  });

  test("an expired entry fails normally again", () => {
    const body = () => undefined;
    const lastDay = new Date(`${listed.expires}T23:59:59.000Z`);
    const nextDay = new Date(`${listed.expires}T23:59:59.000Z`);
    nextDay.setUTCSeconds(nextDay.getUTCSeconds() + 2);
    expect(quarantineExpired(listed, lastDay)).toBe(false);
    expect(quarantineExpired(listed, nextDay)).toBe(true);
    expect(quarantineExpired({ ...listed, expires: "not a date" }, lastDay)).toBe(true);

    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      expect(
        quarantinable(listedFile, listed.test, body, { entries: list, now: () => lastDay }),
      ).not.toBe(body);
      expect(
        quarantinable(listedFile, listed.test, body, { entries: list, now: () => nextDay }),
      ).toBe(body);
    } finally {
      console.log = originalLog;
    }
    expect(String(logs[0])).toStartWith("::warning title=Test quarantine expired::");
  });

  test("a listed body that hangs past its deadline is reported and ends", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    console.log = () => undefined;
    try {
      await quarantinable(listedFile, listed.test, () => new Promise(() => undefined), {
        ...active,
        deadlineMs: 20,
      })();
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(String(errors[0])).toContain("did not finish within 20 ms");
  });

  test("quarantineTest passes unlisted calls through and wraps only listed bodies", () => {
    const calls: unknown[][] = [];
    const base = Object.assign((...args: unknown[]) => calls.push(args), { skip: "skip" });
    const rebound = quarantineTest(base, listedFile, active);
    const body = () => undefined;

    rebound("an unlisted test", body, 5_000);
    expect(calls[0]).toEqual(["an unlisted test", body, 5_000]);
    expect(calls[0]![1]).toBe(body);

    rebound(listed.test, body, 5_000);
    expect(calls[1]![0]).toBe(listed.test);
    expect(calls[1]![1]).not.toBe(body);
    expect(calls[1]![2]).toBe(5_000);

    expect(rebound.skip).toBe("skip");
    expect(() => rebound(listed.test, (_done: unknown) => undefined)).toThrow("done callback");
  });
});
