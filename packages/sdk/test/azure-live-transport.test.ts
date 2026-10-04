import { expect, test } from "bun:test";
import { AzureLiveDataChannel } from "../src/azure-live-transport";
import { parseCodexRealtimeV3Event } from "../src/codex-realtime-v3-wire";
class Wire extends EventTarget {
  readyState = "open";
  sent: Record<string, unknown>[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  emit(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
function fixture(timeout = 5_000) {
  const raw = new Wire();
  const channel = new AzureLiveDataChannel(raw as unknown as RTCDataChannel, timeout);
  const received: any[] = [];
  channel.addEventListener("message", (event) =>
    received.push(JSON.parse((event as MessageEvent).data)),
  );
  return { raw, channel, received };
}
test("interleaved fragments retain order and delegation flushes its input", () => {
  const { raw, channel, received } = fixture();
  raw.emit({ type: "session.input_transcript.delta", delta: "Build ", start_ms: 0, end_ms: 10 });
  raw.emit({ type: "session.input_transcript.delta", delta: "the page", start_ms: 10, end_ms: 20 });
  raw.emit({ type: "session.output_transcript.delta", delta: "On it", start_ms: 20, end_ms: 30 });
  raw.emit({
    type: "session.delegation.created",
    delegation: { id: "delegation-1", target: "client" },
    offset_ms: 30,
  });
  expect(received.map((v) => v.type)).toEqual([
    "transcript.segment",
    "transcript.segment",
    "delegation.created",
  ]);
  expect(received[0].turn.transcript).toBe("Build the page");
  expect(received[1].turn.transcript).toBe("On it");
  for (const event of received)
    expect(parseCodexRealtimeV3Event(JSON.stringify(event)).ok).toBe(true);
  channel.close();
});
test("quiet and speakable context preserve the exact delegation identity", () => {
  const { raw, channel } = fixture();
  raw.emit({ type: "session.delegation.created", delegation: { id: "task-1", target: "client" } });
  channel.send(
    JSON.stringify({
      type: "session.context.append",
      content: [{ type: "input_text", text: "context" }],
    }),
  );
  channel.send(
    JSON.stringify({
      type: "delegation.context.append",
      delegation_item_id: "task-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "Done" }],
    }),
  );
  expect(raw.sent).toEqual([
    { type: "session.thinking.append", content: "context", delegation_id: null },
    { type: "session.commentary.append", content: "Done", delegation_id: "task-1" },
  ]);
  channel.close();
});
test("graceful close drains final provider fragments before returning", async () => {
  const { raw, channel, received } = fixture();
  const drained = channel.drain();
  expect(raw.sent).toEqual([{ type: "session.close" }]);
  raw.emit({
    type: "session.output_transcript.delta",
    delta: "Final words",
    start_ms: 0,
    end_ms: 5,
  });
  raw.emit({ type: "session.closed", usage: { seconds: 15 } });
  await drained;
  expect(received[0].turn.transcript).toBe("Final words");
  channel.close();
  raw.emit({ type: "session.started", session: { id: "late" } });
  expect(received).toHaveLength(1);
});

test("uncertain close can be retried without losing late fragments or resending close", async () => {
  const { raw, channel, received } = fixture(5);
  await expect(channel.drain()).rejects.toThrow("still closing");
  const retry = channel.drain();
  raw.emit({ type: "session.input_transcript.delta", delta: "Late words", start_ms: 1, end_ms: 2 });
  raw.emit({ type: "session.closed" });
  await retry;
  await channel.drain();
  expect(raw.sent).toEqual([{ type: "session.close" }]);
  expect(received[0].turn.transcript).toBe("Late words");
  channel.close();
});
test("replayed delegation IDs from another provider session become general context", () => {
  const { raw, channel } = fixture();
  channel.send(
    JSON.stringify({
      type: "delegation.context.append",
      delegation_item_id: "old-task",
      content: [{ type: "input_text", text: "Previous task finished" }],
    }),
  );
  expect(raw.sent[0]).toEqual({
    type: "session.thinking.append",
    content: "Previous task finished",
    delegation_id: null,
  });
  channel.close();
});
