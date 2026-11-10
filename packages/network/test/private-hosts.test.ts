import { describe, expect, test } from "bun:test";
import {
  pinnedFetch,
  resolvePinnedDestination,
  type DnsAddress,
  type OutboundNetworkSettings,
} from "../src";

const settings: OutboundNetworkSettings = {
  environment: "production",
  integrationsAllowPrivateNetworkTargets: false,
  integrationsPrivateNetworkAllowedHosts: ["admin-api.example.com:443", "auth.example.com"],
};
const privateDns = async (): Promise<DnsAddress[]> => [{ address: "10.0.0.8", family: 4 }];

describe("exact private destination exceptions", () => {
  test.each([
    "https://admin-api.example.com/mcp",
    "https://ADMIN-API.example.com.:443/mcp",
    "https://auth.example.com:8443/token",
  ])("allows %s without the global bypass", async (url) => {
    expect(
      (await resolvePinnedDestination(url, settings, { dnsLookup: privateDns })).addresses,
    ).toEqual(await privateDns());
  });

  test.each([
    "https://other.example.com/mcp",
    "https://sub.admin-api.example.com/mcp",
    "https://admin-api.example.com.attacker.example.com/mcp",
    "https://admin-api.example.com:8443/mcp",
    "http://admin-api.example.com/mcp",
    "https://10.0.0.8/mcp",
  ])("does not extend the exception to %s", async (url) => {
    let calls = 0;
    await expect(
      pinnedFetch(url, undefined, settings, {
        dnsLookup: privateDns,
        fetchImpl: async () => {
          calls++;
          return new Response("unexpected");
        },
      }),
    ).rejects.toMatchObject({ reason: "private_or_special_use" });
    expect(calls).toBe(0);
  });

  test("does not relax HTTPS or DNS-answer validity for allowed hosts", async () => {
    await expect(
      resolvePinnedDestination("http://auth.example.com/token", settings, {
        dnsLookup: privateDns,
        requireHttpsOutsideLocalTest: true,
      }),
    ).rejects.toMatchObject({ reason: "https_required" });
    await expect(
      resolvePinnedDestination("https://auth.example.com/token", settings, {
        dnsLookup: async () => [{ address: "invalid", family: 4 }],
      }),
    ).rejects.toMatchObject({ reason: "invalid_dns_answer" });
  });

  test("permits listed IPv6 DNS answers, but not a different host with the same answer", async () => {
    const dnsLookup = async (): Promise<DnsAddress[]> => [{ address: "fd00::8", family: 6 }];
    await expect(
      resolvePinnedDestination("https://auth.example.com/token", settings, { dnsLookup }),
    ).resolves.toMatchObject({ addresses: [{ address: "fd00::8", family: 6 }] });
    await expect(
      resolvePinnedDestination("https://other.example.com/token", settings, { dnsLookup }),
    ).rejects.toMatchObject({ reason: "private_or_special_use" });
  });

  test("rechecks a non-listed public host when it rebinds to the trusted host's private IP", async () => {
    let lookups = 0;
    let fetches = 0;
    const options = {
      dnsLookup: async (): Promise<DnsAddress[]> => [
        { address: ++lookups === 1 ? "1.1.1.1" : "10.0.0.8", family: 4 },
      ],
      agentFactory: () => ({ close() {}, destroy() {} }),
      fetchImpl: async () => {
        fetches++;
        return new Response("public");
      },
    };
    const first = await pinnedFetch("https://other.example.com/mcp", undefined, settings, options);
    expect(await first.text()).toBe("public");
    await expect(
      pinnedFetch("https://other.example.com/mcp", undefined, settings, options),
    ).rejects.toMatchObject({ reason: "private_or_special_use" });
    expect(fetches).toBe(1);
  });

  test("pins the actual allowed connection and refuses a redirect to another private host", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.url);
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://other.example.com:${server.port}/token`,
          },
        });
      },
    });
    let lookups = 0;
    const policy = {
      ...settings,
      integrationsPrivateNetworkAllowedHosts: [`admin-api.example.com:${server.port}`],
    };
    const options = {
      dnsLookup: async (): Promise<DnsAddress[]> => {
        lookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    };
    try {
      // HTTP is used only for this local socket fixture; production callers
      // separately require HTTPS, tested above. The environment stays production.
      const response = await pinnedFetch(
        `http://admin-api.example.com:${server.port}/mcp`,
        { redirect: "follow" },
        policy,
        options,
      );
      expect(response.status).toBe(302);
      expect(lookups).toBe(1); // no second resolver call at socket connection time
      await expect(
        pinnedFetch(response.headers.get("location")!, undefined, policy, options),
      ).rejects.toMatchObject({ reason: "private_or_special_use" });
      expect(requests).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
