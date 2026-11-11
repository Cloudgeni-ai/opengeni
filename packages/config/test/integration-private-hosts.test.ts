import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

const env = "OPENGENI_INTEGRATIONS_PRIVATE_NETWORK_ALLOWED_HOSTS";

describe("operator private-network hosts", () => {
  test("defaults to no exceptions and leaves the global bypass disabled", () => {
    const settings = getSettings({});
    expect(settings.integrationsPrivateNetworkAllowedHosts).toEqual([]);
    expect(settings.integrationsAllowPrivateNetworkTargets).toBe(false);
    expect(getSettings({ [env]: "  " }).integrationsPrivateNetworkAllowedHosts).toEqual([]);
  });

  test("parses a comma-separated list of exact hosts and optional ports", () => {
    expect(
      getSettings({ [env]: " ADMIN-API.example.com:443, auth.example.com.:8443, example.com " })
        .integrationsPrivateNetworkAllowedHosts,
    ).toEqual(["admin-api.example.com:443", "auth.example.com.:8443", "example.com"]);
  });

  test.each([
    "*.example.com",
    ".example.com",
    "example.com/path",
    "https://example.com",
    "user@example.com",
    "example.com?query",
    "example.com#fragment",
    "example.com:",
    "example.com:0",
    "example.com:65536",
    "example.com:443:8443",
    "example.com:abc",
    "10.0.0.0/8",
    "[::1]",
    "example..com",
    "-example.com",
    "example.com\\evil",
  ])("rejects non-exact or malformed entry %s", (entry) => {
    expect(() => getSettings({ [env]: entry })).toThrow();
  });
});
