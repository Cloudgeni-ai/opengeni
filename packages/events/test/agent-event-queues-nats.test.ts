import { expect, test } from "bun:test";
import { connect, type NatsConnection } from "nats";
import { createNatsEventBus, type EventBus } from "../src/index";

const url = process.env.OPENGENI_TEST_NATS_URL;

test.skipIf(!url)(
  "real NATS distributes state ingestion once while preserving broadcast and member failover",
  async () => {
    const connections: NatsConnection[] = [];
    const buses: EventBus[] = [];
    const stops: Array<() => void> = [];
    const deliveries: number[][] = [[], [], [], []];
    const subject = `test.${crypto.randomUUID()}.events`;
    try {
      for (let index = 0; index < 4; index++) {
        const bus = await createNatsEventBus(url!, undefined, {
          connect: async (options) => {
            const connection = await connect(options);
            connections.push(connection);
            return connection;
          },
        });
        buses.push(bus);
        stops.push(
          bus.subscribeAgentEvents(
            subject,
            (payload) => {
              deliveries[index]!.push(Number(new TextDecoder().decode(payload)));
            },
            index < 2 ? { queue: "state-ingestion" } : undefined,
          ),
        );
      }
      await Promise.all(connections.map((connection) => connection.flush()));
      const send = async (from: number, to: number) => {
        for (let index = from; index < to; index++) {
          connections[3]!.publish(subject, new TextEncoder().encode(String(index)));
        }
        await connections[3]!.flush();
        const deadline = Date.now() + 5_000;
        while (
          deliveries[0]!.length + deliveries[1]!.length < to ||
          deliveries[2]!.length < to ||
          deliveries[3]!.length < to
        ) {
          if (Date.now() >= deadline) throw new Error("NATS deliveries did not complete");
          await Bun.sleep(5);
        }
      };
      await send(0, 20);
      expect([...deliveries[0]!, ...deliveries[1]!].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i),
      );
      expect(deliveries[2]).toHaveLength(20);
      expect(deliveries[3]).toHaveLength(20);
      stops[0]!();
      await connections[0]!.flush();
      const stoppedCount = deliveries[0]!.length;
      await send(20, 25);
      expect(deliveries[0]).toHaveLength(stoppedCount);
      expect(deliveries[1]!.slice(-5)).toEqual([20, 21, 22, 23, 24]);
      expect(deliveries[2]).toHaveLength(25);
      expect(deliveries[3]).toHaveLength(25);
    } finally {
      stops.forEach((stop) => stop());
      await Promise.all(buses.map((bus) => bus.close()));
    }
  },
);
