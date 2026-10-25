import { expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { readSessionResponsePair } from "../src/routes/session-response-reads";
const pool = {} as Database;
const transaction = {
  rollback() {
    throw new Error("rollback");
  },
} as unknown as Database;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

test("independent pool reads start together and preserve response order", async () => {
  const first = gate();
  const second = gate();
  const started: number[] = [];
  const result = readSessionResponsePair(
    pool,
    async () => {
      started.push(1);
      await first.promise;
      return "primary";
    },
    async () => {
      started.push(2);
      await second.promise;
      return "usage";
    },
  );
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  second.release();
  first.release();
  expect(await result).toEqual(["primary", "usage"]);
});
test("transaction readers never overlap their scoped connection", async () => {
  const first = gate();
  const started: number[] = [];
  const result = readSessionResponsePair(
    transaction,
    async () => {
      started.push(1);
      await first.promise;
      return "primary";
    },
    async () => {
      started.push(2);
      return "usage";
    },
  );
  await Promise.resolve();
  expect(started).toEqual([1]);
  first.release();
  expect(await result).toEqual(["primary", "usage"]);
  expect(started).toEqual([1, 2]);
});
test("failure waits for the other read and preserves primary error precedence", async () => {
  const second = gate();
  let finished = false;
  const result = readSessionResponsePair(
    pool,
    async () => {
      throw new Error("primary failure");
    },
    async () => {
      await second.promise;
      throw new Error("usage failure");
    },
  );
  const observed = result.catch((error) => {
    finished = true;
    return error.message;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  second.release();
  expect(await observed).toBe("primary failure");
});
test("synchronous reader failure still drains the sibling", async () => {
  let sibling = false;
  await expect(
    readSessionResponsePair(
      pool,
      () => {
        throw new Error("sync");
      },
      async () => {
        sibling = true;
        return 2;
      },
    ),
  ).rejects.toThrow("sync");
  expect(sibling).toBe(true);
});
