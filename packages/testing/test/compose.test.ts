import { expect, test } from "bun:test";
import { freePort, sandboxBuildFailureMessage } from "../src/compose";

test("sandbox build failures preserve terminal diagnostics in bounded output", () => {
  const message = sandboxBuildFailureMessage({
    exitCode: 1,
    timedOut: false,
    stdout: "build progress\n".repeat(10_000) + "stdout terminal detail",
    stderr: "pull progress\n".repeat(10_000) + "ERROR: terminal failure",
  });
  expect(message).toContain("exit=1 timedOut=false");
  expect(message).toContain("stdout terminal detail");
  expect(message).toContain("ERROR: terminal failure");
  expect(message).toContain("[earlier output omitted]");
  expect(message.length).toBeLessThan(12_250);
});

test("sandbox build failures distinguish timeouts and retain short output", () => {
  const message = sandboxBuildFailureMessage({
    exitCode: 124,
    timedOut: true,
    stdout: "short stdout",
    stderr: "short stderr",
  });
  expect(message).toContain("exit=124 timedOut=true");
  expect(message).toContain("short stdout");
  expect(message).toContain("short stderr");
  expect(message).not.toContain("omitted");
});

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
