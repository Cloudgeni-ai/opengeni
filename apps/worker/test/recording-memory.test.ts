import { describe, expect, test } from "bun:test";
import {
  MemoryBudget,
  speakerDetectionBytes,
  workerMemoryBytes,
} from "../src/activities/recording-memory";
import { totalmem } from "node:os";

const MIB = 1024 * 1024;

describe("the speaker models' memory", () => {
  test("is the container's limit when it has one, else the machine's", () => {
    const files = (entries: Record<string, string>) => (path: string) => {
      const text = entries[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };
    expect(workerMemoryBytes(files({ "/sys/fs/cgroup/memory.max": "2147483648\n" }))).toBe(
      2 * 1024 * MIB,
    );
    expect(workerMemoryBytes(files({ "/sys/fs/cgroup/memory.max": "max\n" }))).toBe(totalmem());
    // cgroup v1 writes no limit as a huge number.
    expect(
      workerMemoryBytes(
        files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }),
      ),
    ).toBe(totalmem());
    expect(
      workerMemoryBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824" })),
    ).toBe(1024 * MIB);
    expect(workerMemoryBytes(files({}))).toBe(totalmem());
  });

  test("grow a little with the length of the audio", () => {
    expect(speakerDetectionBytes(0)).toBe(400 * MIB);
    expect(speakerDetectionBytes(50 * 60_000)).toBe(600 * MIB);
    expect(speakerDetectionBytes(undefined)).toBe(speakerDetectionBytes(2 * 60 * 60_000));
  });
});

describe("a memory budget", () => {
  test("lets jobs in while they fit, and the next one in as one finishes", async () => {
    const budget = new MemoryBudget(1_000);
    const first = await budget.take(600);
    const order: string[] = [];
    const second = budget.take(600).then((release) => {
      order.push("second");
      return release;
    });
    const third = budget.take(300).then((release) => {
      order.push("third");
      return release;
    });
    await Bun.sleep(5);
    // The third would fit, but waits its turn behind the second.
    expect(order).toEqual([]);
    first();
    first();
    const releaseSecond = await second;
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    expect(budget.outBytes).toBe(900);
    releaseSecond();
    releaseThird();
    expect(budget.outBytes).toBe(0);
  });

  test("always runs one job, even one larger than the whole budget", async () => {
    const budget = new MemoryBudget(1_000);
    const release = await budget.take(5_000);
    expect(budget.outBytes).toBe(5_000);
    expect(budget.takeIfFree(1)).toBeNull();
    release();
    expect(budget.takeIfFree(1_000)).not.toBeNull();
  });

  test("tells an idle holder when a job starts waiting", async () => {
    const budget = new MemoryBudget(100);
    const hold = await budget.take(80);
    let told = 0;
    const stop = budget.whenWanted(() => (told += 1));
    expect(budget.wanted).toBe(false);
    const waiting = budget.take(50);
    expect(budget.wanted).toBe(true);
    expect(told).toBe(1);
    stop();
    hold();
    (await waiting)();
    expect(budget.wanted).toBe(false);
    expect(told).toBe(1);
  });

  test("drops a job stopped while it waits", async () => {
    const budget = new MemoryBudget(1_000);
    const release = await budget.take(800);
    const controller = new AbortController();
    const waiting = budget.take(800, controller.signal);
    const after = budget.take(100);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    // The one behind it no longer waits for it.
    (await after)();
    release();
    expect(budget.outBytes).toBe(0);
  });
});
