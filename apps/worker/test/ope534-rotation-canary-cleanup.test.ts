import { expect, test } from "bun:test";
import { runCanaryCleanupStages, withCanaryFixture } from "./ope534-rotation-canary-cleanup";

test("fixture release covers initialization failure before any resource registration", async () => {
  const original = new Error("settings initialization failed");
  let released = false;
  await expect(
    withCanaryFixture(
      async () => ({
        release: async () => {
          released = true;
        },
      }),
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(released).toBe(true);
});

test("inventory, provider, client-close and fixture-release failures all survive original failure", async () => {
  const seen: string[] = [];
  const errors = [
    new Error("original"),
    new Error("inventory"),
    new Error("provider"),
    new Error("client"),
    new Error("fixture"),
  ];
  let caught: unknown;
  try {
    await withCanaryFixture(
      async () => ({
        release: async () => {
          seen.push("fixture");
          throw errors[4];
        },
      }),
      async (_fixture, defer) => {
        defer("client", async () => {
          seen.push("client");
          throw errors[3];
        });
        defer("provider", async () => {
          seen.push("provider");
          throw errors[2];
        });
        defer("inventory", async () => {
          seen.push("inventory");
          throw errors[1];
        });
        throw errors[0];
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(seen).toEqual(["inventory", "provider", "client", "fixture"]);
  expect(caught).toBeInstanceOf(AggregateError);
  const aggregate = caught as AggregateError;
  expect(aggregate.errors[0]).toBe(errors[0]);
  expect((aggregate.errors[1] as AggregateError).errors.map((error: Error) => error.cause)).toEqual(
    [errors[1], errors[2], errors[3]],
  );
  expect(aggregate.errors[2]).toBe(errors[4]);
});

test("cleanup failure prevents successful acceptance", async () => {
  let released = false;
  await expect(
    withCanaryFixture(
      async () => ({
        release: async () => {
          released = true;
        },
      }),
      async (_fixture, defer) => {
        defer("client", async () => {
          throw new Error("close");
        });
        return "passed";
      },
    ),
  ).rejects.toThrow();
  expect(released).toBe(true);
});

test("one snapshot delete failure does not skip other owned snapshots", async () => {
  const seen: number[] = [];
  await expect(
    runCanaryCleanupStages(
      [1, 2, 3].map((id) => ({
        name: `snapshot-${id}`,
        run: async () => {
          seen.push(id);
          if (id === 2) throw new Error("provider unavailable");
        },
      })),
    ),
  ).rejects.toThrow();
  expect(seen).toEqual([1, 2, 3]);
});

test("successful return follows LIFO resource cleanup and final fixture release", async () => {
  const seen: string[] = [];
  const result = await withCanaryFixture(
    async () => ({
      release: async () => {
        seen.push("fixture");
      },
    }),
    async (_fixture, defer) => {
      defer("client", async () => {
        seen.push("client");
      });
      defer("provider", async () => {
        seen.push("provider");
      });
      return 42;
    },
  );
  expect(result).toBe(42);
  expect(seen).toEqual(["provider", "client", "fixture"]);
});
