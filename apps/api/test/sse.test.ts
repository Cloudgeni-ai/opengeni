import { describe, expect, spyOn, test } from "bun:test";
import { createByteBoundedSseStream, createLatestWinsDelivery } from "../src/http/sse";

const oversizedFrame = () => {
  const prefix = "data: ";
  const suffix = "界🙂\u0000\n\n";
  const framingBytes = new TextEncoder().encode(prefix + suffix).byteLength;
  return prefix + "x".repeat(9 * 1024 * 1024 - framingBytes) + suffix;
};

function trackFrameEncoding() {
  const encode = TextEncoder.prototype.encode;
  const encodedBytes: number[] = [];
  const spy = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
    this: TextEncoder,
    input?: string,
  ) {
    const bytes = encode.call(this, input);
    encodedBytes.push(bytes.byteLength);
    return bytes;
  });
  return { encodedBytes, restore: () => spy.mockRestore() };
}

describe("SSE server-side backpressure", () => {
  test("does not encode a capacity-blocked oversized frame when the reader cancels", async () => {
    const largeFrame = oversizedFrame();
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const channel = createByteBoundedSseStream({
      onObservation: ({ reason }) => {
        if (reason === "desired_size_non_positive") markBlocked();
      },
    });
    const reader = channel.stream.getReader();
    const encoding = trackFrameEncoding();
    let pending: Promise<boolean> | undefined;
    try {
      expect(await channel.write("data: small\n\n")).toBeTrue();
      pending = channel.write(largeFrame);
      await blocked;
      const encodedWhileBlocked = [...encoding.encodedBytes];
      await reader.cancel();
      expect(await pending).toBeFalse();
      expect(channel.stopped()).toBeTrue();
      expect(encodedWhileBlocked).toEqual([13]);
      expect(encoding.encodedBytes).toEqual([13]);
    } finally {
      await reader.cancel();
      await pending;
      reader.releaseLock();
      encoding.restore();
    }
  });

  test("does not encode a frame after the stream has stopped", async () => {
    const largeFrame = oversizedFrame();
    const channel = createByteBoundedSseStream();
    const reader = channel.stream.getReader();
    const encoding = trackFrameEncoding();
    try {
      channel.close();
      expect(await channel.write(largeFrame)).toBeFalse();
      expect(encoding.encodedBytes).toEqual([]);
    } finally {
      await reader.cancel();
      reader.releaseLock();
      encoding.restore();
    }
  });

  test("encodes a capacity-blocked oversized frame once after drain without changing UTF-8", async () => {
    const largeFrame = oversizedFrame();
    const expectedBytes = new TextEncoder().encode(largeFrame);
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      markBlocked = resolve;
    });
    const channel = createByteBoundedSseStream({
      onObservation: ({ reason }) => {
        if (reason === "desired_size_non_positive") markBlocked();
      },
    });
    const reader = channel.stream.getReader();
    const encoding = trackFrameEncoding();
    let pending: Promise<boolean> | undefined;
    try {
      expect(await channel.write("data: small\n\n")).toBeTrue();
      pending = channel.write(largeFrame);
      await blocked;
      const encodedWhileBlocked = [...encoding.encodedBytes];
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: small\n\n");
      expect(await pending).toBeTrue();
      const next = await reader.read();
      expect(expectedBytes.byteLength).toBe(9 * 1024 * 1024);
      expect(Bun.deepEquals(next.value, expectedBytes)).toBeTrue();
      channel.close();
      expect((await reader.read()).done).toBeTrue();
      expect(encodedWhileBlocked).toEqual([13]);
      expect(encoding.encodedBytes).toEqual([13, expectedBytes.byteLength]);
    } finally {
      await reader.cancel();
      await pending;
      reader.releaseLock();
      encoding.restore();
    }
  });

  test("does not enqueue another frame until its encoded bytes fit", async () => {
    const channel = createByteBoundedSseStream({ maxQueuedBytes: 8 });

    expect(await channel.write("12345678")).toBeTrue();
    let secondSettled = false;
    const second = channel.write("abcdefgh").then((written) => {
      secondSettled = true;
      return written;
    });
    await Promise.resolve();
    expect(secondSettled).toBeFalse();

    const reader = channel.stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("12345678");
    expect(await second).toBeTrue();
    const next = await reader.read();
    expect(new TextDecoder().decode(next.value)).toBe("abcdefgh");

    channel.close();
    expect((await reader.read()).done).toBeTrue();
  });

  test("delivers an oversized frame intact while blocking the following frame", async () => {
    const channel = createByteBoundedSseStream({ maxQueuedBytes: 4 });
    const text = `data: ${"界🙂".repeat(40_000)}\n\n`;
    expect(await channel.write(text)).toBeTrue();
    let settled = false;
    const nextWrite = channel.write("next").then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBeFalse();
    const reader = channel.stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(text);
    expect(await nextWrite).toBeTrue();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("next");
    channel.close();
    expect((await reader.read()).done).toBeTrue();
  });

  test("consumer cancellation wakes a capacity-blocked writer", async () => {
    let cancelled = 0;
    const channel = createByteBoundedSseStream({
      maxQueuedBytes: 4,
      onStop: () => {
        cancelled += 1;
      },
    });
    expect(await channel.write("1234")).toBeTrue();
    const blocked = channel.write("5678");
    const reader = channel.stream.getReader();
    await reader.cancel();

    expect(await blocked).toBeFalse();
    expect(cancelled).toBe(1);
  });

  test("terminates a non-reading consumer with one queued frame and bounded bytes", async () => {
    const observations: Array<{
      reason: string;
      desiredSize: number | null;
      queuedFrames: number;
      queuedBytes: number;
    }> = [];
    let stopped = 0;
    const channel = createByteBoundedSseStream({
      maxQueuedBytes: 8,
      stallTimeoutMs: 10,
      onStop: () => {
        stopped += 1;
      },
      onObservation: (observation) => observations.push(observation),
    });

    expect(await channel.write("12345678")).toBeTrue();
    await expect(channel.write("abcdefgh")).rejects.toThrow("single-frame queue");

    expect(stopped).toBe(1);
    expect(observations).toContainEqual({
      reason: "desired_size_non_positive",
      desiredSize: 0,
      queuedFrames: 1,
      queuedBytes: 8,
    });
    expect(observations).toContainEqual({
      reason: "stall_timeout",
      desiredSize: 0,
      queuedFrames: 1,
      queuedBytes: 8,
    });
    const reader = channel.stream.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  });
});

describe("latest-wins durable notification delivery", () => {
  test("retains one newest cursor while a slow send drains", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: number[] = [];
    const errors: unknown[] = [];
    const delivery = createLatestWinsDelivery<{ sequence: number }>(async (event) => {
      sent.push(event.sequence);
      if (event.sequence === 1) {
        markFirstStarted();
        await firstReleased;
      }
    }, errors.push.bind(errors));

    delivery.publish([{ sequence: 1 }]);
    await firstStarted;
    delivery.publish([{ sequence: 2 }]);
    delivery.publish([{ sequence: 3 }, { sequence: 2 }]);

    expect(delivery.pendingSequence()).toBe(3);
    expect(sent).toEqual([1]);
    releaseFirst();
    await delivery.whenIdle();

    expect(sent).toEqual([1, 3]);
    expect(errors).toEqual([]);
    expect(delivery.pendingSequence()).toBeNull();
  });
});
