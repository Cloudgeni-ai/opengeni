import { describe, expect, mock, test } from "bun:test";
import { traceFetch } from "@opengeni/observability";
import { usageReadTransportJoin } from "../src/usage-read-transport";

const refusal = "requires an abort-and-join transport";

describe("administered usage read transport", () => {
  const native = (async () => new Response("{}")) as unknown as typeof fetch;

  test("native fetch, also behind request tracing at any depth, needs no join", () => {
    expect(usageReadTransportJoin(native, native, refusal)).toBeNull();
    expect(usageReadTransportJoin(traceFetch(native), native, refusal)).toBeNull();
    expect(usageReadTransportJoin(traceFetch(traceFetch(native)), native, refusal)).toBeNull();
    // A reader loaded after the global was traced still recognizes the native call.
    expect(usageReadTransportJoin(native, traceFetch(native), refusal)).toBeNull();
  });

  test("an injected transport keeps its own join, traced or not", async () => {
    const abortAndJoin = mock(async function (this: unknown, _signal: AbortSignal) {
      expect(this).toBe(injected);
    });
    const injected = Object.assign(async () => new Response("{}"), { abortAndJoin });
    for (const candidate of [injected, traceFetch(injected)]) {
      const join = usageReadTransportJoin(candidate, native, refusal);
      expect(join).not.toBeNull();
      await join!(AbortSignal.abort());
    }
    expect(abortAndJoin).toHaveBeenCalledTimes(2);
  });

  test("any other transport is refused, traced or not", () => {
    const other = async () => new Response("{}");
    expect(() => usageReadTransportJoin(other, native, refusal)).toThrow(refusal);
    expect(() => usageReadTransportJoin(traceFetch(other), native, refusal)).toThrow(refusal);
  });
});
