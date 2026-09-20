import { expect, test } from "bun:test";
import type postgres from "postgres";
import { nativeMcpAccountBindingsFixture } from "./mcp-account-bindings-fixture";

test("native fixture activates lazy driver queries before Bun rejection assertions", async () => {
  // Model Postgres.js Query's Promise subclass: execution starts in then(),
  // not its constructor. No database or network connection is needed.
  let executions = 0;
  let rejectQuery!: (error: Error) => void;
  class LazyQuery extends Promise<unknown> {
    static get [Symbol.species]() {
      return Promise;
    }
    constructor() {
      super((_resolve, reject) => {
        rejectQuery = reject;
      });
    }
    override then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      executions += 1;
      rejectQuery(new Error("requires stopped application roles"));
      return super.then(onfulfilled, onrejected);
    }
  }
  const query = new LazyQuery();
  const fixture = nativeMcpAccountBindingsFixture({
    unsafe: () => query,
    end: async () => {},
  } as unknown as ReturnType<typeof postgres>);
  const result = fixture.exec("BEGIN; migration drain guard");
  // Fail synchronously if the adapter returns the dormant driver subclass;
  // never let a regression itself hang the test runner's rejects matcher.
  expect(result.constructor).toBe(Promise);
  await expect(result).rejects.toThrow("requires stopped application roles");
  expect(executions).toBe(1);
  await fixture.close();
});
