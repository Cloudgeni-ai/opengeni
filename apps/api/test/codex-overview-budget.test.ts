import { expect, test } from "bun:test";
import { codexOverviewProviderCall } from "../src/routes/codex-overview-budget";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("account prefetches and workspace batches share four reads, including queued failures", async () => {
  const owner = {};
  const held = gate();
  let active = 0;
  let maximum = 0;
  const started: number[] = [];
  // Distinct callers model the per-account organization routes and workspace
  // batch. A limiter created for each caller would start all twelve at once.
  const requests = Array.from({ length: 6 }, (_, route) => {
    const call = codexOverviewProviderCall(owner, "organization");
    return [0, 1].map((source) =>
      call(async () => {
        const id = route * 2 + source;
        started.push(id);
        maximum = Math.max(maximum, ++active);
        try {
          await held.promise;
          if (id === 0) throw new Error("provider offline");
          return id;
        } finally {
          active -= 1;
        }
      }),
    );
  }).flat();
  const settled = Promise.allSettled(requests);
  try {
    expect(started).toEqual([0, 1, 2, 3]);
    expect(active).toBe(4);
  } finally {
    held.release();
  }
  const results = await settled;
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(11);
  expect(started).toEqual(Array.from({ length: 12 }, (_, index) => index));
  expect(maximum).toBe(4);
  expect(active).toBe(0);
});

test("a caller retained across idle periods rejoins the current budget", async () => {
  const owner = {};
  const retained = codexOverviewProviderCall(owner, "organization");
  await expect(retained(async () => "first")).resolves.toBe("first");
  const held = gate();
  const fresh = codexOverviewProviderCall(owner, "organization");
  const blockers = Array.from({ length: 4 }, () => fresh(() => held.promise));
  let started = false;
  const later = retained(async () => {
    started = true;
    return "later";
  });
  try {
    expect(started).toBe(false);
  } finally {
    held.release();
  }
  await Promise.all(blockers);
  await expect(later).resolves.toBe("later");
});

test("an occupied organization does not block another organization or API instance", async () => {
  const owner = {};
  const held = gate();
  const call = codexOverviewProviderCall(owner, "organization");
  const blockers = Array.from({ length: 4 }, () => call(() => held.promise));
  try {
    await expect(
      codexOverviewProviderCall(owner, "other")(async () => "other organization"),
    ).resolves.toBe("other organization");
    await expect(
      codexOverviewProviderCall({}, "organization")(async () => "other API"),
    ).resolves.toBe("other API");
  } finally {
    held.release();
    await Promise.all(blockers);
  }
});
