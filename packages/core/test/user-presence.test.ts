import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";

import { createUserPresenceRecorder } from "../src/user-presence";

const db = {} as Database;
const alice = "user:alice-0000-1111";
const bob = "user:bob-00000-2222";

function recorder(options: { fail?: boolean } = {}) {
  let now = 1_000_000;
  const writes: string[][] = [];
  const counts: string[] = [];
  const presence = createUserPresenceRecorder({
    db,
    flushDelayMs: 600_000,
    now: () => now,
    record: async (_db, subjects) => {
      if (options.fail) throw new Error("database unavailable");
      writes.push([...subjects]);
      return subjects.length;
    },
    observability: {
      incrementCounter: (input) => counts.push(String(input.labels?.outcome)),
      warn: () => undefined,
    },
  });
  return { presence, writes, counts, advance: (ms: number) => (now += ms) };
}

describe("user presence recorder", () => {
  test("batches people and writes each at most once per throttle window", async () => {
    const { presence, writes, counts, advance } = recorder();
    presence.touch(alice);
    presence.touch(alice);
    presence.touch(bob);
    await presence.flush();
    expect(writes).toEqual([[alice, bob]]);

    advance(30_000);
    presence.touch(alice);
    await presence.flush();
    expect(writes).toHaveLength(1);

    advance(31_000);
    presence.touch(alice);
    await presence.flush();
    expect(writes).toEqual([[alice, bob], [alice]]);
    expect(counts).toEqual(["ok", "ok"]);
  });

  test("never records API keys, services, local or embedded subjects", async () => {
    const { presence, writes } = recorder();
    for (const subject of [
      "api_key:abcdefgh1234",
      "service:scheduler",
      "dev",
      "configured:host-user",
      "user:short",
    ]) {
      presence.touch(subject);
    }
    await presence.flush();
    expect(writes).toEqual([]);
  });

  test("a failed write is retried on the next touch instead of waiting a window", async () => {
    const failing = recorder({ fail: true });
    failing.presence.touch(alice);
    await failing.presence.flush();
    expect(failing.counts).toEqual(["failed"]);
    failing.presence.touch(alice);
    await failing.presence.flush();
    expect(failing.counts).toEqual(["failed", "failed"]);
  });

  test("close flushes queued people and stops accepting more", async () => {
    const { presence, writes } = recorder();
    presence.touch(alice);
    await presence.close();
    presence.touch(bob);
    await presence.flush();
    expect(writes).toEqual([[alice]]);
  });
});
