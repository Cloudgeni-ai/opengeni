import { describe, expect, test } from "bun:test";
import { createByteBoundedSseStream, createLatestWinsDelivery } from "../src/http/sse";

describe("SSE server-side backpressure", () => {
  test("does not enqueue another frame until its encoded bytes fit", async () => {
    const channel = createByteBoundedSseStream(8);

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

  test("rejects a frame larger than the entire byte queue", async () => {
    const channel = createByteBoundedSseStream(4);
    await expect(channel.write("12345")).rejects.toThrow("cannot fit");
    channel.close();
  });

  test("consumer cancellation wakes a capacity-blocked writer", async () => {
    let cancelled = 0;
    const channel = createByteBoundedSseStream(4, () => {
      cancelled += 1;
    });
    expect(await channel.write("1234")).toBeTrue();
    const blocked = channel.write("5678");
    const reader = channel.stream.getReader();
    await reader.cancel();

    expect(await blocked).toBeFalse();
    expect(cancelled).toBe(1);
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
