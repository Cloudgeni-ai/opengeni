import { describe, expect, test } from "bun:test";
import { armTurnQuiescenceWatchdog } from "../src/activities/agent-turn/quiescence";

describe("turn quiescence watchdog", () => {
  test("terminates a worker whose fenced writer drain never settles", async () => {
    let terminated = false;
    armTurnQuiescenceWatchdog({
      enabled: true,
      timeoutMs: 1,
      terminateWorker: () => {
        terminated = true;
      },
    });
    await Bun.sleep(10);
    expect(terminated).toBe(true);
  });

  test("disarms after the durable receipt is established", async () => {
    let terminated = false;
    const disarm = armTurnQuiescenceWatchdog({
      enabled: true,
      timeoutMs: 1,
      terminateWorker: () => {
        terminated = true;
      },
    });
    disarm();
    await Bun.sleep(10);
    expect(terminated).toBe(false);
  });
});
