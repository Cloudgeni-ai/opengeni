import { describe, expect, test } from "bun:test";
import { autoConnectConnectorsToTry } from "../src/domain/mcp-auto-connect";

function connector(n: number) {
  return {
    id: `connector-${n}`,
    config: {
      connectionRef: { providerDomain: `app${n}.test` },
      autoConnect: {
        authorizationServerIssuer: `https://auth.app${n}.test`,
        tokenEndpoint: `https://auth.app${n}.test/token`,
        clientId: "https://opengeni.test/v1/integrations/oauth/client-metadata.json",
        mcpUrl: `https://app${n}.test/mcp`,
      },
    },
  };
}

function login(n: number, mcpUrl = `https://app${n}.test/mcp`, turnedOnHere = true) {
  return { providerDomain: `APP${n}.test`, turnedOnHere, metadata: { mcpUrl } };
}

describe("the auto-connect connectors a turn tries", () => {
  const five = [1, 2, 3, 4, 5].map(connector);

  test("tries at most four", () => {
    expect(autoConnectConnectorsToTry(five, []).map((c) => c.id)).toEqual([
      "connector-1",
      "connector-2",
      "connector-3",
      "connector-4",
    ]);
  });

  test("apps the person already has a login to don't starve later ones", () => {
    const working = [1, 2, 3, 4].map((n) => login(n));
    expect(autoConnectConnectorsToTry(five, working).map((c) => c.id)).toEqual(["connector-5"]);
  });

  test("a login to the same app counts with a trailing slash; another MCP URL doesn't", () => {
    expect(
      autoConnectConnectorsToTry([connector(1)], [login(1, "https://app1.test/mcp/")]),
    ).toEqual([]);
    expect(
      autoConnectConnectorsToTry([connector(1)], [login(1, "https://app1.test/other")]).map(
        (c) => c.id,
      ),
    ).toEqual(["connector-1"]);
  });

  test("a login made in another workspace is still tried, so connecting turns it on here", () => {
    expect(
      autoConnectConnectorsToTry([connector(1)], [login(1, undefined, false)]).map((c) => c.id),
    ).toEqual(["connector-1"]);
  });
});
