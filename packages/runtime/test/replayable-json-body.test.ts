import { describe, expect, test } from "bun:test";
import {
  ReplayableJsonBody,
  ReplayableJsonOpenAI,
  requestBodyText,
} from "../src/replayable-json-body";

async function encoded(body: ReplayableJsonBody): Promise<string> {
  return await requestBodyText(body.createStream());
}

async function expectNativeEncoding(factory: () => unknown): Promise<void> {
  const nativeValue = factory();
  const streamedValue = factory();
  expect(await encoded(new ReplayableJsonBody(streamedValue))).toBe(JSON.stringify(nativeValue));
}

function seededValues(seed: number, count: number): unknown[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const primitive = (): unknown => {
    switch (Math.floor(random() * 12)) {
      case 0:
        return null;
      case 1:
        return random() < 0.5;
      case 2:
        return Math.floor(random() * 2_000_000) - 1_000_000;
      case 3:
        return random() * 1e100;
      case 4:
        return Number.NaN;
      case 5:
        return Number.POSITIVE_INFINITY;
      case 6:
        return -0;
      case 7:
        return undefined;
      case 8:
        return Symbol("omitted");
      case 9:
        return () => "omitted";
      case 10:
        return `controls:\u0000\b\t\n\f\r quote:" slash:\\ ${String.fromCharCode(0xd800)}`;
      default:
        return `unicode:${String.fromCodePoint(0x1f9ea)}:${Math.floor(random() * 10_000)}`;
    }
  };
  const make = (depth: number): unknown => {
    if (depth === 0 || random() < 0.45) return primitive();
    if (random() < 0.5) {
      const array = Array.from({ length: Math.floor(random() * 8) }, () => make(depth - 1));
      if (array.length > 1 && random() < 0.5) delete array[1];
      return array;
    }
    const object: Record<string, unknown> = {};
    const length = Math.floor(random() * 8);
    for (let index = 0; index < length; index += 1) {
      object[`k${index}:${Math.floor(random() * 5)}`] = make(depth - 1);
    }
    return object;
  };
  return Array.from({ length: count }, () => ({ input: make(4), stream: random() < 0.5 }));
}

describe("replayable JSON model requests", () => {
  test("matches native JSON.stringify across model-request edge cases", async () => {
    const sparse = Array<unknown>(5);
    sparse[0] = "first";
    sparse[1] = undefined;
    sparse[3] = Number.NaN;
    sparse[4] = Number.POSITIVE_INFINITY;
    const source = {
      model: 'model/with-"quotes"',
      omitted: undefined,
      input: [
        { type: "message", content: "unicode: 🧪\nline" },
        null,
        sparse,
        { toJSON: () => ({ projected: true }) },
      ],
      tools: [{ name: "tool", strict: false }],
      stream: true,
    };
    const body = new ReplayableJsonBody(source);

    expect(await encoded(body)).toBe(JSON.stringify(source));
    expect(await encoded(body)).toBe(JSON.stringify(source));
  });

  test("passes the exact property key to nested and top-level toJSON hooks", async () => {
    const observedNative: string[] = [];
    const observedStreamed: string[] = [];
    const fixture = (observed: string[]) => ({
      toJSON(key: string) {
        observed.push(key);
        return {
          input: [
            {
              toJSON(childKey: string) {
                observed.push(childKey);
                return { childKey };
              },
            },
          ],
        };
      },
    });

    expect(await encoded(new ReplayableJsonBody(fixture(observedStreamed)))).toBe(
      JSON.stringify(fixture(observedNative)),
    );
    expect(observedStreamed).toEqual(observedNative);
    expect(observedStreamed).toEqual(["", "0"]);
  });

  test("matches boxed primitives, dates, collections, typed arrays, and spoofed tags", async () => {
    await expectNativeEncoding(() => ({
      number: new Number(Number.NaN),
      string: new String("boxed\nvalue"),
      boolean: new Boolean(false),
      date: new Date("2025-01-02T03:04:05.000Z"),
      typed: new Uint8Array([1, 2, 255]),
      map: new Map([["ignored", 1]]),
      set: new Set([1, 2]),
      spoofed: { [Symbol.toStringTag]: "Number", value: 7 },
    }));
  });

  test("matches native getter ordering and key/length snapshot semantics", async () => {
    const objectEvents: string[][] = [[], []];
    const objectFixture = (events: string[]) => {
      const source: Record<string, unknown> = {
        get first() {
          events.push("first");
          delete source.third;
          source.fourth = 4;
          return 1;
        },
        get second() {
          events.push("second");
          return 2;
        },
        third: 3,
      };
      return source;
    };
    const nativeObject = objectFixture(objectEvents[0]);
    const streamedObject = objectFixture(objectEvents[1]);
    expect(await encoded(new ReplayableJsonBody(streamedObject))).toBe(
      JSON.stringify(nativeObject),
    );
    expect(objectEvents[1]).toEqual(objectEvents[0]);

    const arrayEvents: string[][] = [[], []];
    const arrayFixture = (events: string[]) => {
      const source = [0, 1, 2];
      Object.defineProperty(source, "0", {
        enumerable: true,
        configurable: true,
        get() {
          events.push("zero");
          source.length = 1;
          return 0;
        },
      });
      return source;
    };
    const nativeArray = arrayFixture(arrayEvents[0]);
    const streamedArray = arrayFixture(arrayEvents[1]);
    expect(await encoded(new ReplayableJsonBody(streamedArray))).toBe(JSON.stringify(nativeArray));
    expect(arrayEvents[1]).toEqual(arrayEvents[0]);
  });

  test("matches native output for deterministic nested fuzz cases", async () => {
    for (const value of seededValues(0xc0ffee, 256)) {
      expect(await encoded(new ReplayableJsonBody(value))).toBe(JSON.stringify(value));
    }
  });

  test("bounds encoded chunks without corrupting escapes or surrogate pairs", async () => {
    const text = `${"a".repeat(65_534)}${String.fromCodePoint(0x1f9ea)}${'\\"\n'.repeat(80_000)}`;
    const source = { input: [{ content: text }], stream: true };
    const chunks: Uint8Array[] = [];
    for await (const chunk of new ReplayableJsonBody(source)) chunks.push(chunk);

    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(JSON.stringify(source));
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(256 * 1024);
    expect(chunks.length).toBeGreaterThan(2);
  });

  test("preserves native serializer failures", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(encoded(new ReplayableJsonBody({ input: [cyclic] }))).rejects.toThrow(
      /cyclic|circular/i,
    );
    await expect(encoded(new ReplayableJsonBody({ input: [1n] }))).rejects.toThrow(/BigInt/i);

    const shared = { allowed: true };
    await expectNativeEncoding(() => ({ input: [shared, shared] }));
  });

  test("replays identical Responses and Chat bodies through SDK network retries", async () => {
    const source = {
      model: "benchmark",
      stream: false,
      input: Array.from({ length: 100 }, (_, index) => ({
        type: "message",
        role: "user",
        content: `${index}:${"x".repeat(2_000)}`,
      })),
    };
    for (const path of ["/responses", "/chat/completions"]) {
      const observed: string[] = [];
      let calls = 0;
      const client = new ReplayableJsonOpenAI({
        apiKey: "test",
        baseURL: "https://replayable.test/v1",
        maxRetries: 1,
        fetch: async (_input, init) => {
          calls += 1;
          observed.push(await requestBodyText(init?.body));
          return calls === 1
            ? Response.json(
                { error: { type: "server_error", message: "retry" } },
                { status: 500, headers: { "retry-after-ms": "0" } },
              )
            : Response.json({ ok: true });
        },
      });

      const response = await client.post<{ ok: boolean }>(path, { body: source });
      expect(response).toEqual({ ok: true });
      expect(calls).toBe(2);
      expect(observed).toEqual([JSON.stringify(source), JSON.stringify(source)]);
    }
  });

  test("preserves and case-insensitively overrides every OpenAI header representation", async () => {
    const headerShapes: unknown[] = [
      {
        "x-existing": "plain-object",
        "Content-Type": "text/plain",
        "X-Policy": "stale",
      },
      new Headers({
        "x-existing": "headers-instance",
        "Content-Type": "text/plain",
        "X-Policy": "stale",
      }),
      [
        ["x-existing", "tuple-array"],
        ["Content-Type", "text/plain"],
        ["X-Policy", "stale"],
      ],
      {
        values: new Headers({
          "x-existing": "nullable-shape",
          "Content-Type": "text/plain",
          "X-Policy": "stale",
        }),
        nulls: new Set(["x-removed"]),
      },
    ];

    for (const headers of headerShapes) {
      let policyCalls = 0;
      let observedHeaders = new Headers();
      let observedBody = "";
      const client = new ReplayableJsonOpenAI(
        {
          apiKey: "test",
          baseURL: "https://headers.test/v1",
          maxRetries: 0,
          fetch: async (_input, init) => {
            observedHeaders = new Headers(init?.headers);
            observedBody = await requestBodyText(init?.body);
            return Response.json({ ok: true });
          },
        },
        {
          modelRequestPolicy: ({ body }) => {
            policyCalls += 1;
            return {
              body: { ...body, policyApplied: true },
              headers: { "x-policy": "current" },
            };
          },
        },
      );

      await client.post("/responses", {
        body: { model: "benchmark", input: [] },
        headers: headers as never,
      });

      expect(policyCalls).toBe(1);
      expect(observedHeaders.get("x-existing")).toBeTruthy();
      expect(observedHeaders.get("x-policy")).toBe("current");
      expect(observedHeaders.get("content-type")).toBe("application/json");
      expect(observedHeaders.has("x-removed")).toBe(false);
      expect(JSON.parse(observedBody)).toEqual({
        model: "benchmark",
        input: [],
        policyApplied: true,
      });
    }
  });
});
