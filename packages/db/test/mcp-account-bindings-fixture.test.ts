import { expect, test } from "bun:test";
import postgres from "postgres";
import {
  nativeMcpAccountBindingsFixture,
  nativeMcpAccountBindingsJsonTypes,
} from "./mcp-account-bindings-fixture";

test("native fixture sends pre-encoded JSON as JSON rather than a JSON string", async () => {
  // Client construction installs the actual driver's serializers but does not
  // open a socket. Exercise both server-inferred JSON OIDs without a database.
  const defaults = postgres();
  const native = postgres({ types: nativeMcpAccountBindingsJsonTypes });
  try {
    for (const oid of [114, 3802]) {
      for (const value of [
        [],
        [{ serverId: "account-test", ownerSubjectId: null }],
        { mcpAccountBindings: [] },
        null,
      ]) {
        const encoded = JSON.stringify(value);
        const oldWire = defaults.options.serializers[oid]!(encoded) as string;
        expect(JSON.parse(oldWire)).toBe(encoded);
        const wire = native.options.serializers[oid]!(encoded) as string;
        expect(wire).toBe(encoded);
        expect(JSON.parse(wire)).toEqual(value);
        expect(native.options.parsers[oid]!(wire)).toEqual(value);
      }
    }
    expect(native.options.serializers[16]!(true)).toBe(defaults.options.serializers[16]!(true));
  } finally {
    await native.end();
    await defaults.end();
  }
});

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
