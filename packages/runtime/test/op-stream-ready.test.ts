import { expect, test } from "bun:test";
import {
  NatsOpStreamTransport,
  type NatsOpStreamConnection,
} from "../src/sandbox/selfhosted/op-transport";

function connection() {
  type Message = { data: Uint8Array };
  const subscriptions = new Map<string, { emit: (data: Uint8Array) => void; closed: boolean }>();
  const reconnects = new Set<() => void>();
  const raw: NatsOpStreamConnection = {
    subscribe(subject) {
      const queued: Message[] = [];
      let wake: (() => void) | undefined;
      const state = {
        closed: false,
        emit: (data: Uint8Array) => {
          queued.push({ data });
          wake?.();
        },
      };
      subscriptions.set(subject, state);
      return {
        async *[Symbol.asyncIterator]() {
          while (!state.closed) {
            if (queued.length) yield queued.shift()!;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        },
        unsubscribe() {
          state.closed = true;
          wake?.();
        },
      };
    },
    publish() {},
    subscribeReconnect(listener) {
      reconnects.add(listener);
      return () => {
        reconnects.delete(listener);
      };
    },
  };
  return { raw, subscriptions, reconnects };
}

test("stream recovery observes only its exact runner and cleans up both ready sources", async () => {
  const { raw, subscriptions, reconnects } = connection();
  const transport = new NatsOpStreamTransport(async () => raw);
  const subject = "agent.workspace.machine.connection.instance.op.operation";
  const hello = "agent.workspace.machine.connection.instance.hello";
  let ready = 0;
  const frames: number[] = [];
  const stream = await transport.subscribe(
    subject,
    (data) => frames.push(...data),
    () => ready++,
  );
  expect([...subscriptions.keys()]).toEqual([subject, hello]);
  const reconnect = [...reconnects][0]!;
  reconnect();
  subscriptions.get(hello)!.emit(new Uint8Array());
  subscriptions.get(subject)!.emit(new Uint8Array([42]));
  await Bun.sleep(0);
  expect(ready).toBe(2);
  expect(frames).toEqual([42]);
  stream.unsubscribe();
  stream.unsubscribe();
  reconnect(); // An already-queued notification cannot revive a torn consumer.
  subscriptions.get(hello)!.emit(new Uint8Array());
  await Bun.sleep(0);
  expect(ready).toBe(2);
  expect(reconnects.size).toBe(0);
  expect([...subscriptions.values()].every((sub) => sub.closed)).toBe(true);
});

test("frame-only callers do not install recovery listeners", async () => {
  const { raw, subscriptions, reconnects } = connection();
  const transport = new NatsOpStreamTransport(async () => raw);
  const stream = await transport.subscribe("agent.w.a.connection.i.op.o", () => {});
  expect(subscriptions.size).toBe(1);
  expect(reconnects.size).toBe(0);
  stream.unsubscribe();
});
