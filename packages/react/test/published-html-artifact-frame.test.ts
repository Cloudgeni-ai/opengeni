import { describe, expect, test } from "bun:test";
import {
  SiteBridgeDocumentLease,
  SiteBridgeRequestRegistry,
  siteBridgeError,
} from "../src/components/artifacts/published-html-artifact-frame";

function port(): MessagePort & { closeCount: number } {
  return {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
  } as MessagePort & { closeCount: number };
}

describe("Site bridge request ownership", () => {
  test("preserves uncertain mutation settlement in bridge errors", () => {
    expect(
      siteBridgeError(
        Object.assign(new Error("Provider settlement is unknown"), {
          code: "tool_outcome_unknown",
          retryable: false,
          outcomeUnknown: true,
        }),
      ),
    ).toEqual({
      code: "tool_outcome_unknown",
      message: "Provider settlement is unknown",
      retryable: false,
      outcomeUnknown: true,
    });
  });

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

  test("issues one document bootstrap and revokes it on iframe navigation", async () => {
    const channels: MessageChannel[] = [];
    const attached: MessagePort[] = [];
    let closeActiveCount = 0;
    const posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const lease = new SiteBridgeDocumentLease(
      (_data, ports) => attached.push(...ports),
      () => {
        closeActiveCount += 1;
      },
      () => {
        const channel = new MessageChannel();
        channels.push(channel);
        return channel;
      },
    );
    const frameWindow = {
      postMessage(message: unknown, _targetOrigin: string, transfer: Transferable[]) {
        posted.push({ message, transfer });
      },
    } as Pick<Window, "postMessage">;

    expect(lease.load(frameWindow)).toBe(true);
    expect(posted).toHaveLength(1);
    const childBootstrap = posted[0]!.transfer[0] as MessagePort;
    const toolChannel = new MessageChannel();
    childBootstrap.postMessage({ type: "opengeni.site.connect", version: 2 }, [toolChannel.port1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attached).toEqual([toolChannel.port1]);

    expect(lease.load(frameWindow)).toBe(false);
    expect(posted).toHaveLength(1);
    expect(closeActiveCount).toBe(1);
    lease.close();
    childBootstrap.close();
    toolChannel.port2.close();
    for (const channel of channels) channel.port1.close();
  });
});
