import { expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { createConnectedCommandCompletionLocator } from "../src/sandbox/completion-locator";

const identity = () => ({
  controlWorkspaceId: crypto.randomUUID(),
  enrollmentId: crypto.randomUUID(),
  connectionInstanceId: crypto.randomUUID(),
  opId: crypto.randomUUID(),
});

test("batch failures reject every waiter and do not poison subsequent fresh reads", async () => {
  let calls = 0;
  const failure = new Error("database unavailable");
  const db = {
    execute: async () => {
      if (++calls === 1) throw failure;
      return [];
    },
  } as unknown as Database;
  const locate = createConnectedCommandCompletionLocator(db);
  const input = identity();
  const outcomes = await Promise.allSettled([
    locate(input),
    locate(input),
    locate({ ...input, opId: "other" }),
  ]);
  expect(outcomes).toEqual(
    Array.from({ length: 3 }, () => ({ status: "rejected", reason: failure })),
  );
  expect(calls).toBe(1);
  expect(await locate(input)).toBeNull();
  expect(calls).toBe(2);
});

test("new arrivals during SQL get a new batch rather than sharing in-flight state", async () => {
  const resolvers: Array<(rows: never[]) => void> = [];
  const db = {
    execute: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  } as unknown as Database;
  const locate = createConnectedCommandCompletionLocator(db);
  const input = identity();
  const first = locate(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(resolvers).toHaveLength(1);
  const second = locate(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(resolvers).toHaveLength(2);
  resolvers[1]!([]);
  expect(await second).toBeNull();
  resolvers[0]!([]);
  expect(await first).toBeNull();
});

test("large pending sets respect the existing classifier's input limit without dropping waiters", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls++;
      return [];
    },
  } as unknown as Database;
  const locate = createConnectedCommandCompletionLocator(db);
  const input = identity();
  expect(
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => locate({ ...input, opId: String(i) })),
    ),
  ).toEqual(Array.from({ length: 1001 }, () => null));
  expect(calls).toBe(2);
});
