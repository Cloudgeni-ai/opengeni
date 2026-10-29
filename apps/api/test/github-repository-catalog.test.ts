import { describe, expect, test } from "bun:test";
import type { GitHubRepository } from "@opengeni/contracts";
import { GitHubAppApiError, GitHubAppConfigurationError } from "@opengeni/github";
import { isTransientGitHubRepositoryListFailure } from "../src/github-access";
import { createGitHubRepositoryCatalog } from "../src/github-repository-catalog";

function repo(id: number, installationId = 1): GitHubRepository {
  return { id, installationId, fullName: `acme/repo-${id}` } as unknown as GitHubRepository;
}

function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("GitHub repository catalog", () => {
  test("passive reads reuse a fresh list and refetch once it expires", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({ freshMs: 60_000, now: time.now });
    let calls = 0;
    const load = async () => [repo(++calls)];

    expect(await catalog.read([1], load)).toEqual([repo(1)]);
    time.advance(59_999);
    expect(await catalog.read([1], load)).toEqual([repo(1)]);
    expect(calls).toBe(1);

    time.advance(1);
    expect(await catalog.read([1], load)).toEqual([repo(2)]);
    expect(calls).toBe(2);
  });

  test("installation order and duplicates share one entry; other sets do not", async () => {
    const catalog = createGitHubRepositoryCatalog({ now: clock().now });
    let calls = 0;
    const load = async () => [repo(++calls)];

    await catalog.read([2, 1], load);
    await catalog.read([1, 2, 2], load);
    expect(calls).toBe(1);
    await catalog.read([1], load);
    expect(calls).toBe(2);
  });

  test("concurrent passive reads share one GitHub call", async () => {
    const catalog = createGitHubRepositoryCatalog({ now: clock().now });
    const pending = deferred<GitHubRepository[]>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };

    const first = catalog.read([1], load);
    const second = catalog.read([1], load);
    pending.resolve([repo(7)]);
    expect(await first).toEqual([repo(7)]);
    expect(await second).toEqual([repo(7)]);
    expect(calls).toBe(1);
  });

  test("a passive read GitHub fails gets the last good list within the stale window", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({
      freshMs: 60_000,
      staleIfErrorMs: 30 * 60_000,
      now: time.now,
    });
    await catalog.read([1], async () => [repo(1)]);

    time.advance(10 * 60_000);
    const failing = async (): Promise<GitHubRepository[]> => {
      throw new Error("GitHub 502");
    };
    expect(await catalog.read([1], failing)).toEqual([repo(1)]);

    time.advance(20 * 60_000);
    await expect(catalog.read([1], failing)).rejects.toThrow("GitHub 502");
  });

  test("a passive read with nothing cached reports GitHub's failure", async () => {
    const catalog = createGitHubRepositoryCatalog({ now: clock().now });
    await expect(
      catalog.read([1], async () => {
        throw new Error("GitHub 503");
      }),
    ).rejects.toThrow("GitHub 503");
  });

  test("a fresh read always asks GitHub, reports failure, and updates the cache", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({ now: time.now });
    await catalog.read([1], async () => [repo(1)]);

    await expect(
      catalog.read(
        [1],
        async () => {
          throw new Error("GitHub 500");
        },
        { fresh: true },
      ),
    ).rejects.toThrow("GitHub 500");

    expect(await catalog.read([1], async () => [repo(2)], { fresh: true })).toEqual([repo(2)]);
    let passiveCalls = 0;
    expect(
      await catalog.read([1], async () => {
        passiveCalls += 1;
        return [repo(3)];
      }),
    ).toEqual([repo(2)]);
    expect(passiveCalls).toBe(0);
  });

  test("a fresh read does not join a passive fetch that started before it", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({ now: time.now });
    const slow = deferred<GitHubRepository[]>();
    const passive = catalog.read([1], () => slow.promise);

    time.advance(1);
    expect(await catalog.read([1], async () => [repo(2)], { fresh: true })).toEqual([repo(2)]);

    // The older passive fetch finishing later does not replace the newer list.
    slow.resolve([repo(1)]);
    expect(await passive).toEqual([repo(1)]);
    expect(
      await catalog.read([1], async () => {
        throw new Error("unexpected GitHub call");
      }),
    ).toEqual([repo(2)]);
  });

  test("the oldest installation set is dropped beyond maxEntries", async () => {
    const catalog = createGitHubRepositoryCatalog({ maxEntries: 2, now: clock().now });
    let calls = 0;
    const load = async () => [repo(++calls)];

    await catalog.read([1], load);
    await catalog.read([2], load);
    await catalog.read([3], load);
    expect(calls).toBe(3);
    await catalog.read([3], load);
    await catalog.read([2], load);
    expect(calls).toBe(3);
    await catalog.read([1], load);
    expect(calls).toBe(4);
  });

  test("a list fetched before the binding last changed is not reused", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({ freshMs: 60_000, now: time.now });
    let calls = 0;
    const load = async () => [repo(++calls)];

    expect(await catalog.read([1], load, { notBefore: time.now() - 1 })).toEqual([repo(1)]);
    time.advance(10);
    // Reconnected on another replica after this process fetched its list.
    const reboundAt = time.now() - 5;
    expect(await catalog.read([1], load, { notBefore: reboundAt })).toEqual([repo(2)]);
    expect(await catalog.read([1], load, { notBefore: reboundAt })).toEqual([repo(2)]);
    expect(calls).toBe(2);
  });

  test("a passive read does not join a fetch that began before the binding changed", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({ now: time.now });
    const older = deferred<GitHubRepository[]>();
    let calls = 0;
    const first = catalog.read([1], () => {
      calls += 1;
      return older.promise;
    });
    time.advance(10);
    const second = catalog.read(
      [1],
      async () => {
        calls += 1;
        return [repo(2)];
      },
      { notBefore: time.now() - 1 },
    );
    expect(await second).toEqual([repo(2)]);
    older.resolve([repo(1)]);
    expect(await first).toEqual([repo(1)]);
    expect(calls).toBe(2);
  });

  test("only failures the caller calls transient get the last good list", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({
      freshMs: 1_000,
      now: time.now,
      serveStaleOn: (error) => error instanceof Error && error.message === "GitHub 502",
    });
    await catalog.read([1], async () => [repo(1)]);
    time.advance(1_000);
    expect(
      await catalog.read([1], async () => {
        throw new Error("GitHub 502");
      }),
    ).toEqual([repo(1)]);
    await expect(
      catalog.read([1], async () => {
        throw new Error("installation removed");
      }),
    ).rejects.toThrow("installation removed");
  });

  test("lists past the stale window are dropped", async () => {
    const time = clock();
    const catalog = createGitHubRepositoryCatalog({
      freshMs: 1_000,
      staleIfErrorMs: 10_000,
      maxEntries: 10,
      now: time.now,
    });
    await catalog.read([1], async () => [repo(1)]);
    time.advance(10_000);
    // Expired on read: GitHub's failure is reported, not hidden by an old list.
    await expect(
      catalog.read([1], async () => {
        throw new Error("GitHub 502");
      }),
    ).rejects.toThrow("GitHub 502");
    await catalog.read([2], async () => [repo(2)]);
    time.advance(10_000);
    // Expired entries are swept when another list is stored.
    await catalog.read([3], async () => [repo(3)]);
    await expect(
      catalog.read([2], async () => {
        throw new Error("GitHub 502");
      }),
    ).rejects.toThrow("GitHub 502");
  });
});

describe("GitHub repository list failures served from the last good list", () => {
  test("outages are; configuration and lost access are not", () => {
    const transient = isTransientGitHubRepositoryListFailure;
    expect(transient(new GitHubAppApiError("Bad Gateway", 502))).toBe(true);
    expect(transient(new GitHubAppApiError("Too Many Requests", 429))).toBe(true);
    expect(transient(new GitHubAppApiError("API rate limit exceeded for installation", 403))).toBe(
      true,
    );
    expect(transient(new TypeError("fetch failed"))).toBe(true);
    expect(
      transient(new GitHubAppApiError("GitHub returned an invalid repositories payload")),
    ).toBe(true);
    expect(transient(new GitHubAppApiError("Not Found", 404))).toBe(false);
    expect(transient(new GitHubAppApiError("Bad credentials", 401))).toBe(false);
    expect(transient(new GitHubAppApiError("Resource not accessible by integration", 403))).toBe(
      false,
    );
    expect(transient(new GitHubAppConfigurationError(["GITHUB_APP_ID"]))).toBe(false);
  });
});
