import { expect, test } from "bun:test";
import { MemoryEventBus } from "../src/fakes";

test("agent events reach every broadcast listener and one member per queue, including after unsubscribe", async () => {
  const bus = new MemoryEventBus();
  const received = [0, 0, 0, 0, 0];
  const pattern = "agent.*.*.connection.*.events";
  const subscribe = (index: number, queue?: string) =>
    bus.subscribeAgentEvents(
      pattern,
      () => {
        received[index]!++;
      },
      queue ? { queue } : undefined,
    );
  subscribe(0);
  subscribe(1);
  const stop = subscribe(2, "ingestion");
  subscribe(3, "ingestion");
  subscribe(4, "other-consumer");
  const emit = () =>
    bus.emitAgentEvent("agent.ws.agent.connection.instance.events", new Uint8Array());
  await emit();
  await emit();
  expect(received).toEqual([2, 2, 1, 1, 2]);
  stop();
  await emit();
  expect(received).toEqual([3, 3, 1, 2, 3]);
});
