import { describe, expect, test } from "bun:test";

import {
  createImmutableRawObjectReader,
  ImmutableRawObjectReadError,
  MAX_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES,
  type ObjectHead,
  type ObjectStorage,
} from "../src";

describe("immutable raw-object serving reader", () => {
  test("streams only exact version-pinned ranges and detaches provider buffers", async () => {
    const fixture = memoryStorage(new TextEncoder().encode("abcdefghij"));
    const reader = createImmutableRawObjectReader(fixture.storage);
    const head = await reader.head({ key: "apps/releases/release/assets/index.html" });
    expect(head).toEqual({
      byteSize: 10,
      versionToken: "generation:1",
      contentType: "text/html; charset=utf-8",
    });

    const chunks = await consume(
      reader.streamRange({
        key: "apps/releases/release/assets/index.html",
        start: 1,
        endInclusive: 8,
        expectedVersionToken: head!.versionToken,
        chunkBytes: 3,
      }),
    );
    expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["bcd", "efg", "hi"]);
    expect(fixture.ranges).toEqual([
      [1, 3],
      [4, 6],
      [7, 8],
    ]);
    chunks[0]![0] = 0;
    expect(new TextDecoder().decode(fixture.bytes)).toBe("abcdefghij");
  });

  test("fails closed without raw primitives or valid immutable metadata", async () => {
    expect(() => createImmutableRawObjectReader({})).toThrow("raw HEAD");

    let rangeCalls = 0;
    const reader = createImmutableRawObjectReader({
      async headObject(): Promise<ObjectHead> {
        return { ContentLength: 4, ContentType: "text/html" };
      },
      async getObjectRange() {
        rangeCalls += 1;
        return null;
      },
    });
    await expect(reader.head({ key: "apps/invalid" })).rejects.toMatchObject({
      code: "invalid_object",
    });
    expect(rangeCalls).toBe(0);
  });

  test("rejects malformed requests before storage and scrubs backend diagnostics", async () => {
    const secretKey = "apps/private/provider-key?credential=secret";
    let calls = 0;
    const reader = createImmutableRawObjectReader({
      async headObject() {
        calls += 1;
        throw new Error(`provider failed for ${secretKey}`);
      },
      async getObjectRange() {
        calls += 1;
        return null;
      },
    });

    await expect(reader.head({ key: " ../bad" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toBe(0);

    let failure: unknown;
    try {
      await reader.head({ key: secretKey });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ImmutableRawObjectReadError);
    expect((failure as ImmutableRawObjectReadError).code).toBe("backend_failure");
    expect((failure as Error).message).not.toContain(secretKey);
  });

  test("rejects replacement, truncation, oversized chunks, and cancellation", async () => {
    const fixture = memoryStorage(new Uint8Array([1, 2, 3, 4]));
    const reader = createImmutableRawObjectReader(fixture.storage);
    await expect(
      reader.readRange({
        key: "apps/releases/release/assets/app.js",
        start: 0,
        endInclusive: 1,
        expectedVersionToken: "stale",
      }),
    ).resolves.toBeNull();

    fixture.truncate = true;
    await expect(
      reader.readRange({
        key: "apps/releases/release/assets/app.js",
        start: 0,
        endInclusive: 2,
        expectedVersionToken: "generation:1",
      }),
    ).rejects.toMatchObject({ code: "truncated" });

    expect(() =>
      reader.streamRange({
        key: "apps/releases/release/assets/app.js",
        start: 0,
        endInclusive: 1,
        expectedVersionToken: "generation:1",
        chunkBytes: MAX_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES + 1,
      }),
    ).toThrow("invalid");

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      reader.streamRange({
        key: "apps/releases/release/assets/app.js",
        start: 0,
        endInclusive: 1,
        expectedVersionToken: "generation:1",
        signal: controller.signal,
      }),
    ).toThrow("aborted");
  });
});

function memoryStorage(initialBytes: Uint8Array): {
  storage: Pick<ObjectStorage, "headObject" | "getObjectRange">;
  bytes: Uint8Array;
  ranges: Array<[number, number]>;
  truncate: boolean;
} {
  const fixture = {
    bytes: initialBytes.slice(),
    ranges: [] as Array<[number, number]>,
    truncate: false,
    storage: {} as Pick<ObjectStorage, "headObject" | "getObjectRange">,
  };
  fixture.storage = {
    async headObject() {
      return {
        ContentLength: fixture.bytes.byteLength,
        ContentType: "text/html; charset=utf-8",
        VersionToken: "generation:1",
      };
    },
    async getObjectRange(input) {
      if (input.expectedVersionToken !== "generation:1") return null;
      fixture.ranges.push([input.start, input.endInclusive]);
      const bytes = fixture.bytes.slice(input.start, input.endInclusive + 1);
      return {
        bytes: fixture.truncate ? bytes.subarray(0, Math.max(0, bytes.byteLength - 1)) : bytes,
        versionToken: "generation:1",
      };
    },
  };
  return fixture;
}


async function consume(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const item = await reader.read();
    if (item.done) return chunks;
    chunks.push(item.value);
  }
}
