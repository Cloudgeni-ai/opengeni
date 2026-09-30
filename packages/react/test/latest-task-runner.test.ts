import { describe, expect, test } from "bun:test";

import { createLatestTaskRunner } from "../src/components/artifacts/latest-task-runner";

describe("createLatestTaskRunner", () => {
  test("runs one task at a time and starts only the newest waiting task", async () => {
    const schedule = createLatestTaskRunner();
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    schedule(async () => {
      started.push(0);
      await gate;
    });
    for (let index = 1; index <= 5; index += 1) {
      schedule(async () => {
        started.push(index);
      });
    }
    expect(started).toEqual([0]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 5]);
  });

  test("keeps running after a task fails", async () => {
    const schedule = createLatestTaskRunner();
    const started: string[] = [];
    schedule(async () => {
      started.push("fails");
      throw new Error("load failed");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    schedule(async () => {
      started.push("next");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["fails", "next"]);
  });
});
