import { describe, expect, test } from "bun:test";
import { SiteBridgeRequestRegistry } from "../src/components/artifacts/published-html-artifact-frame";

function port(): MessagePort & { closeCount: number } {
  return {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
  } as MessagePort & { closeCount: number };
}

describe("Site bridge request ownership", () => {
  test("scopes request ids per port and aborts work when the port is replaced", () => {
    const registry = new SiteBridgeRequestRegistry();
    const firstPort = port();
    const secondPort = port();
    registry.replacePort(firstPort);
    const first = registry.start(firstPort, "request-1");
    expect(first).not.toBeNull();
    expect(registry.start(firstPort, "request-1")).toBeNull();

    registry.replacePort(secondPort);
    expect(first?.signal.aborted).toBe(true);
    expect(firstPort.closeCount).toBe(1);
    const second = registry.start(secondPort, "request-1");
    expect(second).not.toBeNull();

    registry.cancel(secondPort, "request-1");
    expect(second?.signal.aborted).toBe(true);
    registry.closeAll();
    expect(secondPort.closeCount).toBe(1);
  });
});
