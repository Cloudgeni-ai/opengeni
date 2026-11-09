import { describe, expect, test } from "bun:test";
import { allSettledInOrder } from "../src/http/settled-in-order";

describe("allSettledInOrder", () => {
  test("returns every value in list order", async () => {
    const [first, second, third] = await allSettledInOrder([
      Promise.resolve(1),
      new Promise<string>((resolve) => setTimeout(() => resolve("two"), 5)),
      Promise.resolve(null),
    ] as const);
    expect(first).toBe(1);
    expect(second).toBe("two");
    expect(third).toBeNull();
  });

  test("starts the operations together", async () => {
    const started: string[] = [];
    const gate = Promise.withResolvers<void>();
    const read = async (name: string) => {
      started.push(name);
      await gate.promise;
      return name;
    };
    const pending = allSettledInOrder([read("a"), read("b"), read("c")] as const);
    expect(started).toEqual(["a", "b", "c"]);
    gate.resolve();
    expect(await pending).toEqual(["a", "b", "c"]);
  });

  test("throws the first failure in list order, not the first to settle", async () => {
    const early = new Error("later in the list, settles first");
    const late = new Error("earlier in the list, settles last");
    const result = allSettledInOrder([
      Promise.resolve("ok"),
      new Promise((_, reject) => setTimeout(() => reject(late), 10)),
      Promise.reject(early),
    ] as const);
    await expect(result).rejects.toBe(late);
  });

  test("waits for every operation before reporting a failure", async () => {
    let slowFinished = false;
    const failure = new Error("first");
    const result = allSettledInOrder([
      Promise.reject(failure),
      new Promise((resolve) =>
        setTimeout(() => {
          slowFinished = true;
          resolve("slow");
        }, 10),
      ),
    ] as const);
    await expect(result).rejects.toBe(failure);
    expect(slowFinished).toBe(true);
  });
});
