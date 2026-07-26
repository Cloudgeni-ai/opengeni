import { expect, test } from "bun:test";
import { freePort } from "../src/compose";

test("test listener ports stay outside the Linux ephemeral client range", async () => {
  const ports = await Promise.all(Array.from({ length: 32 }, () => freePort()));

  expect(new Set(ports).size).toBe(ports.length);
  expect(ports.every((port) => port >= 20_000 && port <= 29_999)).toBe(true);

  for (const port of ports) {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    listener.stop(true);
  }
});
