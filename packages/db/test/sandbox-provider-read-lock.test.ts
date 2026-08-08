import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";

import {
  withSandboxProviderReadLock,
  type Database,
  type SandboxProviderReadLockIdentity,
} from "../src/database";

class FakeAdvisoryLocks {
  private readonly owners = new Map<string, symbol>();

  database(): Database {
    return {
      transaction: async <T>(fn: (tx: Database) => Promise<T>) => {
        const owner = Symbol("transaction");
        const held = new Set<string>();
        const tx = {
          execute: async (query: SQL) => {
            const key = (query as SQL & { queryChunks: unknown[] }).queryChunks.find(
              (chunk): chunk is string =>
                typeof chunk === "string" && chunk.startsWith("sandbox-provider-read:"),
            );
            if (!key) throw new Error("unexpected fake database query");
            const current = this.owners.get(key);
            const acquired = current === undefined || current === owner;
            if (acquired) {
              this.owners.set(key, owner);
              held.add(key);
            }
            return [{ acquired }];
          },
        } as unknown as Database;
        try {
          return await fn(tx);
        } finally {
          for (const key of held) {
            if (this.owners.get(key) === owner) this.owners.delete(key);
          }
        }
      },
    } as unknown as Database;
  }
}

const identity: SandboxProviderReadLockIdentity = {
  workspaceId: "ws_1",
  sandboxGroupId: "sg_1",
  leaseEpoch: 4,
  instanceId: "sb_1",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sandbox provider read lock", () => {
  test("serializes the same exact lease identity across independent database handles", async () => {
    const locks = new FakeAdvisoryLocks();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const first = withSandboxProviderReadLock(locks.database(), identity, undefined, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;
    const second = withSandboxProviderReadLock(locks.database(), identity, undefined, async () => {
      secondEntered = true;
      return "second";
    });

    await Bun.sleep(50);
    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(secondEntered).toBe(true);
  });

  test("a near-identical different provider instance remains concurrent", async () => {
    const locks = new FakeAdvisoryLocks();
    const bothEntered = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const run = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothEntered.resolve();
      await release.promise;
      active -= 1;
    };

    const first = withSandboxProviderReadLock(locks.database(), identity, undefined, run);
    const second = withSandboxProviderReadLock(
      locks.database(),
      { ...identity, instanceId: "sb_2" },
      undefined,
      run,
    );
    await bothEntered.promise;
    expect(maxActive).toBe(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  test("planted no-lock control reproduces overlapping same-instance requests", async () => {
    const bothEntered = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const uncoordinated = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothEntered.resolve();
      await release.promise;
      active -= 1;
    };

    const first = uncoordinated();
    const second = uncoordinated();
    await bothEntered.promise;
    expect(maxActive).toBe(2);
    release.resolve();
    await Promise.all([first, second]);
  });
});
