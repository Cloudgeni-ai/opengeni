import { describe, expect, test } from "bun:test";
import {
  BoundedObjectReadError,
  createBoundedObjectReadPort,
  type VersionedRangeObjectBackend,
} from "../src/bounded-object-read";

describe("bounded version-pinned object reads", () => {
  test("streams exact copied ranges without accumulating the complete object", async () => {
    const fixture = memoryBackend(new TextEncoder().encode("abcdefghij"));
    const reader = await createBoundedObjectReadPort(fixture.backend).open({
      opaqueReference: "opaque:one",
      maxBytes: 10,
      expectedByteSize: 10,
    });
    const chunks: string[] = [];
    for await (const chunk of reader.chunks({ chunkBytes: 3 })) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    expect(chunks).toEqual(["abc", "def", "ghi", "j"]);
    expect(fixture.ranges).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 9],
    ]);
    await reader.assertUnchanged();
    await reader.close();
    expect(fixture.closed).toBe(1);
  });

  test("rejects missing, oversized, and mismatched-length objects before reading", async () => {
    const missing = memoryBackend(new Uint8Array(), { missing: true });
    await expect(
      createBoundedObjectReadPort(missing.backend).open({
        opaqueReference: "opaque:missing",
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "object_missing" });

    const oversized = memoryBackend(new Uint8Array(11));
    await expect(
      createBoundedObjectReadPort(oversized.backend).open({
        opaqueReference: "opaque:large",
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "size_limit" });
    await expect(
      createBoundedObjectReadPort(oversized.backend).open({
        opaqueReference: "opaque:length",
        maxBytes: 20,
        expectedByteSize: 10,
      }),
    ).rejects.toMatchObject({ code: "truncated" });

    const mutableBackend = {
      ...oversized.backend,
      async describe() {
        return {
          byteSize: 1,
          versionToken: "v1",
          immutableReference: false,
        } as never;
      },
    };
    await expect(
      createBoundedObjectReadPort(mutableBackend).open({
        opaqueReference: "raw/mutable/key",
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "backend_failure" });
  });

  test("rejects truncated and replacement ranges", async () => {
    const truncated = memoryBackend(new Uint8Array([1, 2, 3, 4]), {
      truncateRange: true,
    });
    const truncatedReader = await createBoundedObjectReadPort(truncated.backend).open({
      opaqueReference: "opaque:truncated",
      maxBytes: 4,
    });
    await expect(consume(truncatedReader.chunks({ chunkBytes: 2 }))).rejects.toMatchObject({
      code: "truncated",
    });
    expect(truncated.closed).toBe(1);

    const replaced = memoryBackend(new Uint8Array([1, 2, 3, 4]), {
      replaceAtRange: 2,
    });
    const replacedReader = await createBoundedObjectReadPort(replaced.backend).open({
      opaqueReference: "opaque:replaced",
      maxBytes: 4,
    });
    await expect(consume(replacedReader.chunks({ chunkBytes: 2 }))).rejects.toMatchObject({
      code: "object_changed",
    });
    expect(replaced.closed).toBe(1);
  });

  test("detects replacement during final revalidation", async () => {
    const fixture = memoryBackend(new Uint8Array([1, 2, 3]));
    const reader = await createBoundedObjectReadPort(fixture.backend).open({
      opaqueReference: "opaque:changed-after-read",
      maxBytes: 3,
    });
    // Revalidate before consuming because consuming intentionally closes the
    // range handle; the immutable version check remains independently usable.
    fixture.version = "v2";
    await expect(reader.assertUnchanged()).rejects.toMatchObject({
      code: "object_changed",
    });
    await reader.close();
    expect(fixture.closed).toBe(1);
  });

  test("cancellation closes once and never leaks provider diagnostics", async () => {
    const secret = "bucket/private/provider-key?sig=secret";
    const controller = new AbortController();
    const fixture = memoryBackend(new Uint8Array([1, 2, 3, 4]), {
      onRange() {
        controller.abort();
      },
    });
    const reader = await createBoundedObjectReadPort(fixture.backend).open({
      opaqueReference: secret,
      maxBytes: 4,
    });
    let failure: unknown;
    try {
      await consume(reader.chunks({ chunkBytes: 2, signal: controller.signal }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundedObjectReadError);
    expect((failure as BoundedObjectReadError).code).toBe("aborted");
    expect((failure as Error).message).not.toContain(secret);
    expect(fixture.closed).toBe(1);

    const describeController = new AbortController();
    const cancelledDescribe = memoryBackend(new Uint8Array([1]), {
      onDescribe: () => describeController.abort(),
    });
    await expect(
      createBoundedObjectReadPort(cancelledDescribe.backend).open({
        opaqueReference: "opaque:cancelled-describe",
        maxBytes: 1,
        signal: describeController.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    const revalidateController = new AbortController();
    const cancelledRevalidation = memoryBackend(new Uint8Array([1]), {
      onDescribe: (count) => {
        if (count === 2) revalidateController.abort();
      },
    });
    const revalidationReader = await createBoundedObjectReadPort(
      cancelledRevalidation.backend,
    ).open({
      opaqueReference: "opaque:cancelled-revalidation",
      maxBytes: 1,
      signal: revalidateController.signal,
    });
    await expect(
      revalidationReader.assertUnchanged(revalidateController.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    await revalidationReader.close();

    const failing: VersionedRangeObjectBackend = {
      async describe() {
        throw new Error(`failed at ${secret}`);
      },
      async readRange() {
        return null;
      },
    };
    await expect(
      createBoundedObjectReadPort(failing).open({
        opaqueReference: secret,
        maxBytes: 4,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "backend_failure",
        message: "Bounded object read failed",
      }),
    );
  });

  test("a handle is single-use and range buffers are detached", async () => {
    const fixture = memoryBackend(new Uint8Array([1, 2, 3]));
    const reader = await createBoundedObjectReadPort(fixture.backend).open({
      opaqueReference: "opaque:single-use",
      maxBytes: 3,
    });
    const iterable = reader.chunks({ chunkBytes: 3 });
    expect(() => reader.chunks()).toThrow("invalid");
    const chunks = await consume(iterable);
    chunks[0]![0] = 99;
    expect(fixture.bytes[0]).toBe(1);
    await reader.close();
  });
});

async function consume(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function memoryBackend(
  initialBytes: Uint8Array,
  options: {
    missing?: boolean;
    truncateRange?: boolean;
    replaceAtRange?: number;
    onRange?: () => void;
    onDescribe?: (count: number) => void;
  } = {},
): {
  backend: VersionedRangeObjectBackend;
  bytes: Uint8Array;
  version: string;
  ranges: Array<[number, number]>;
  closed: number;
} {
  const fixture = {
    bytes: initialBytes.slice(),
    version: "v1",
    ranges: [] as Array<[number, number]>,
    closed: 0,
    backend: {} as VersionedRangeObjectBackend,
  };
  let reads = 0;
  let descriptions = 0;
  fixture.backend = {
    async describe() {
      descriptions += 1;
      options.onDescribe?.(descriptions);
      if (options.missing) return null;
      return {
        byteSize: fixture.bytes.byteLength,
        versionToken: fixture.version,
        immutableReference: true,
        contentType: "application/octet-stream",
      };
    },
    async readRange(input) {
      reads += 1;
      fixture.ranges.push([input.start, input.endInclusive]);
      options.onRange?.();
      if (options.replaceAtRange === reads) fixture.version = "v2";
      const bytes = fixture.bytes.slice(input.start, input.endInclusive + 1);
      return {
        bytes: options.truncateRange ? bytes.subarray(0, -1) : bytes,
        versionToken: fixture.version,
      };
    },
    close() {
      fixture.closed += 1;
    },
  };
  return fixture;
}
