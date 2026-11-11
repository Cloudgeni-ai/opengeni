import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QUARANTINE,
  quarantinable,
  quarantineEnforced,
  quarantineEntry,
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
      expect(entry.issue).toMatch(
        /^https:\/\/(linear\.app\/[^/]+\/issue\/[A-Z]+-\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+)/,
      );
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      const key = `${entry.file}\u0000${entry.test}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
    }
  });
});

describe("quarantinable", () => {
  const listed = QUARANTINE[0]!;
  const listedFile = resolve(repositoryRoot, listed.file);

  test("matches entries by repository-relative file and exact title", () => {
    expect(quarantineEntry(listedFile, listed.test)).toBe(listed);
    expect(quarantineEntry(listedFile, `${listed.test} (another case)`)).toBeUndefined();
    expect(quarantineEntry(resolve(repositoryRoot, "nope.test.ts"), listed.test)).toBeUndefined();
  });

  test("a listed failure is reported instead of failing", async () => {
    const errors: unknown[] = [];
    const logs: unknown[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await quarantinable(listedFile, listed.test, () => {
        throw new Error("flaked");
      })();
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
    expect(quarantinable(listedFile, "an unlisted test", body)).toBe(body);
  });

  test("enforce mode fails listed tests again", () => {
    const body = () => undefined;
    const previous = process.env.OPENGENI_TEST_QUARANTINE;
    process.env.OPENGENI_TEST_QUARANTINE = "enforce";
    try {
      expect(quarantineEnforced()).toBe(true);
      expect(quarantinable(listedFile, listed.test, body)).toBe(body);
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_TEST_QUARANTINE;
      else process.env.OPENGENI_TEST_QUARANTINE = previous;
    }
  });

  test("a listed body that hangs past its deadline is reported and ends", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    console.log = () => undefined;
    try {
      await quarantinable(listedFile, listed.test, () => new Promise(() => undefined), {
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
    const rebound = quarantineTest(base, listedFile);
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
