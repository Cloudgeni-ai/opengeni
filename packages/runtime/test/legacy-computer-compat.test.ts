import { describe, expect, test } from "bun:test";
import type { SandboxSessionLike } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";
import {
  ComputerUnavailableError,
  SandboxComputer,
  buildAgentCapabilities,
  computerUse,
  type BuildAgentOptions,
} from "../src";

describe("legacy computer compatibility", () => {
  test("preserves the 1.x source surface while failing closed", async () => {
    const session = {} as SandboxSessionLike;
    const computer = new SandboxComputer(session, { dimensions: [800, 600] });
    expect(computer.dimensions).toEqual([800, 600]);
    computer.rebind(session);
    await expect(computer.screenshot()).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(computer.click(1, 2, "left")).rejects.toBeInstanceOf(ComputerUnavailableError);
    expect(computerUse({ toolMode: "function-image" }).tools()).toEqual([]);
  });

  test("accepts deprecated build options without restoring desktop tools", () => {
    const options: BuildAgentOptions = {
      computerToolMode: "function-image",
      onComputerUseReady: async () => undefined,
    };
    expect(
      buildAgentCapabilities(testSettings(), [], {
        computerToolMode: options.computerToolMode,
        onComputerUseReady: options.onComputerUseReady,
      }).map((capability) => (capability as { type?: unknown }).type),
    ).not.toContain("computer-use");
  });
});
