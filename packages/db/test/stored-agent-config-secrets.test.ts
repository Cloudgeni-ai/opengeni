import { describe, expect, test } from "bun:test";
import { allAgentCapabilities } from "@opengeni/contracts";
import { parseStoredSessionAgentConfig } from "../src/index";

/** A row frozen before the `secrets` capability existed (AG-5/AG-7, Q-17). */
function storedBeforeSecrets(from: "all" | "none") {
  const capabilities: Record<string, unknown> = { ...allAgentCapabilities() };
  delete capabilities.secrets;
  return {
    version: 1,
    from,
    capabilities,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

describe("stored session agent configs and the secrets capability", () => {
  test("historical rows parse with secrets defaulted from their starting point", () => {
    expect(parseStoredSessionAgentConfig(storedBeforeSecrets("all"))?.capabilities.secrets).toBe(
      true,
    );
    expect(parseStoredSessionAgentConfig(storedBeforeSecrets("none"))?.capabilities.secrets).toBe(
      false,
    );
  });

  test("an explicit stored choice wins and unusable rows stay legacy", () => {
    const explicit = storedBeforeSecrets("all");
    expect(
      parseStoredSessionAgentConfig({
        ...explicit,
        capabilities: { ...explicit.capabilities, secrets: false },
      })?.capabilities.secrets,
    ).toBe(false);
    expect(parseStoredSessionAgentConfig(null)).toBeNull();
    expect(parseStoredSessionAgentConfig({ version: 1, from: "all" })).toBeNull();
  });
});
