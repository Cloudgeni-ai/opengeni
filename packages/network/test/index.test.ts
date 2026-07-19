import { describe, expect, test } from "bun:test";
import {
  DestinationPolicyError,
  isNonPublicAddress,
  pinnedFetch,
  readResponseBodyBounded,
  ResponseBodyLimitError,
  validateHttpUrl,
  type DispatcherLifecycle,
  type DnsAddress,
  type OutboundNetworkSettings,
} from "../src";

const production: OutboundNetworkSettings = {
  environment: "production",
  integrationsAllowPrivateNetworkTargets: false,
};

const testEscape: OutboundNetworkSettings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
};

describe("DNS-pinned outbound transport", () => {
  test("rejects a public-then-private DNS answer before the request implementation", async () => {
    let fetchCalls = 0;
    let agentCalls = 0;
    const requestHeaders = new Headers({ authorization: "Bearer secret" });
    const requestBody = "client_secret=secret&refresh_token=refresh";

    await expect(
      pinnedFetch(
        "https://rebind.example.test/token",
        { method: "POST", headers: requestHeaders, body: requestBody },
        production,
        {
          dnsLookup: async () => [
            { address: "1.1.1.1", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
          agentFactory: () => {
            agentCalls += 1;
            return fakeDispatcher();
          },
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response("unexpected");
          },
        },
      ),
    ).rejects.toMatchObject<Partial<DestinationPolicyError>>({
      reason: "private_or_special_use",
    });

    expect(fetchCalls).toBe(0);
    expect(agentCalls).toBe(0);
    // The rejected request never reaches a request implementation carrying any
    // Authorization/client_secret/refresh_token material.
    expect(JSON.stringify(requestHeaders) + requestBody).toContain("secret");
  });

  test("classifies IPv4, IPv6, and mapped-address special-use matrices", () => {
    for (const address of [
      "0.0.0.0",
      "10.12.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.31.255.255",
      "192.0.0.9",
      "192.0.2.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.88.99.1",
      "192.168.1.1",
      "192.175.48.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b:1::a00:1",
      "fc00::1",
      "fe80::1",
      "fec0::1",
      "feff::1",
      "ff02::1",
      "2001:1::1",
      "2001:2::1",
      "2001:db8::1",
      "2001::1",
      "2002::1",
      "2620:4f:8000::1",
      "3ffe::1",
      "5f00::1",
      "4000::1",
      "6000::1",
      "64:ff9b::1",
    ]) {
      expect(isNonPublicAddress(address)).toBe(true);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isNonPublicAddress(address)).toBe(false);
    }
  });

  test("keeps special-purpose prefix boundaries fail closed without rejecting adjacent public space", () => {
    for (const [inside, outside] of [
      ["192.31.196.255", "192.31.197.0"],
      ["192.52.193.255", "192.52.194.0"],
      ["192.175.48.255", "192.175.49.0"],
      ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:200::"],
      ["2620:4f:8000:ffff:ffff:ffff:ffff:ffff", "2620:4f:8001::"],
      ["3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", "3ffd::"],
    ] as const) {
      expect(isNonPublicAddress(inside)).toBe(true);
      expect(isNonPublicAddress(outside)).toBe(false);
    }
  });

  test("keeps the local/test escape explicit while still using the supplied address", async () => {
    const addresses: DnsAddress[][] = [];
    let fetchCalls = 0;
    const response = await pinnedFetch("https://local.example.test/mcp", undefined, testEscape, {
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      agentFactory: (pinned) => {
        addresses.push([...pinned]);
        return fakeDispatcher();
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("allowed");
      },
    });

    expect(await response.text()).toBe("allowed");
    expect(fetchCalls).toBe(1);
    expect(addresses).toEqual([[{ address: "127.0.0.1", family: 4 }]]);
  });

  test("re-pins each redirect hop independently", async () => {
    const lookedUp: string[] = [];
    const pinned: string[][] = [];
    const responseFor = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(init?.redirect).toBe("manual");
      return url.hostname === "first.example.test"
        ? new Response(null, { status: 302, headers: { location: "https://second.example.test/" } })
        : new Response("second");
    };
    const dnsLookup = async (hostname: string): Promise<readonly DnsAddress[]> => {
      lookedUp.push(hostname);
      return hostname === "first.example.test"
        ? [{ address: "1.1.1.1", family: 4 }]
        : [{ address: "8.8.8.8", family: 4 }];
    };

    const first = await pinnedFetch(
      "https://first.example.test/",
      { headers: { accept: "application/json" } },
      production,
      {
        dnsLookup,
        agentFactory: (addresses) => {
          pinned.push(addresses.map((entry) => entry.address));
          return fakeDispatcher();
        },
        fetchImpl: responseFor,
      },
    );
    expect(first.status).toBe(302);
    await first.body?.cancel();

    const second = await pinnedFetch(
      "https://second.example.test/",
      { headers: { accept: "application/json" } },
      production,
      {
        dnsLookup,
        agentFactory: (addresses) => {
          pinned.push(addresses.map((entry) => entry.address));
          return fakeDispatcher();
        },
        fetchImpl: responseFor,
      },
    );
    expect(await second.text()).toBe("second");
    expect(lookedUp).toEqual(["first.example.test", "second.example.test"]);
    expect(pinned).toEqual([["1.1.1.1"], ["8.8.8.8"]]);
  });

  test("pins the actual Undici connection and never resolves again after fetch begins", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("pinned"),
    });
    let lookupCalls = 0;
    try {
      const response = await pinnedFetch(
        `http://rebinding.example.test:${server.port}/`,
        undefined,
        testEscape,
        {
          dnsLookup: async () => {
            lookupCalls += 1;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        },
      );
      expect(await response.text()).toBe("pinned");
      expect(lookupCalls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("closes after body completion and destroys after cancel or stream error", async () => {
    const completed = lifecycle();
    const completedResponse = await pinnedFetch("https://1.1.1.1/complete", undefined, production, {
      agentFactory: () => completed.dispatcher,
      fetchImpl: async () => new Response("complete"),
    });
    expect(await completedResponse.text()).toBe("complete");
    expect(completed.closed).toBe(1);
    expect(completed.destroyed).toBe(0);

    const cancelled = lifecycle();
    const cancelledResponse = await pinnedFetch("https://1.1.1.1/cancel", undefined, production, {
      agentFactory: () => cancelled.dispatcher,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull() {
              // Intentionally left pending until the consumer cancels.
            },
          }),
        ),
    });
    await cancelledResponse.body?.cancel("test cancel");
    expect(cancelled.closed).toBe(0);
    expect(cancelled.destroyed).toBe(1);

    const failed = lifecycle();
    const failedResponse = await pinnedFetch("https://1.1.1.1/error", undefined, production, {
      agentFactory: () => failed.dispatcher,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
        ),
    });
    await expect(failedResponse.text()).rejects.toThrow("stream failed");
    expect(failed.closed).toBe(0);
    expect(failed.destroyed).toBe(1);

    const fetchFailed = lifecycle();
    await expect(
      pinnedFetch("https://1.1.1.1/fetch-failure", undefined, production, {
        agentFactory: () => fetchFailed.dispatcher,
        fetchImpl: async () => {
          throw new Error("request failed");
        },
      }),
    ).rejects.toThrow("request failed");
    expect(fetchFailed.closed).toBe(0);
    expect(fetchFailed.destroyed).toBe(1);
  });
});

describe("bounded response readers", () => {
  test("accepts an exact declared and streamed limit", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": "3" },
    });
    expect([...(await readResponseBodyBounded(response, 3, "OAuth response"))]).toEqual([1, 2, 3]);
  });

  test("rejects a declared body above the limit before consuming it", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
    });
    await expect(readResponseBodyBounded(response, 3, "OAuth response")).rejects.toMatchObject<
      Partial<ResponseBodyLimitError>
    >({
      reason: "declared_length",
      actualBytes: 4,
      maxBytes: 3,
    });
  });

  test("rejects the first streamed byte beyond the limit and cleans a pinned dispatcher", async () => {
    const state = lifecycle();
    const response = await pinnedFetch("https://1.1.1.1/oversized", undefined, production, {
      agentFactory: () => state.dispatcher,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4]));
              controller.close();
            },
          }),
        ),
    });
    await expect(readResponseBodyBounded(response, 3, "OAuth response")).rejects.toMatchObject<
      Partial<ResponseBodyLimitError>
    >({
      reason: "stream_overflow",
      actualBytes: 4,
      maxBytes: 3,
    });
    expect(state.destroyed).toBe(1);
  });

  test("rejects malformed content-length without exposing response content", async () => {
    const response = new Response("provider secret", {
      headers: { "content-length": "not-a-length" },
    });
    await expect(readResponseBodyBounded(response, 32, "OAuth response")).rejects.toMatchObject<
      Partial<ResponseBodyLimitError>
    >({ reason: "invalid_content_length" });
  });
});

describe("HTTP endpoint validation", () => {
  test("accepts normal HTTPS URLs and canonicalizes them", () => {
    expect(validateHttpUrl("https://login.example.test/authorize")).toBe(
      "https://login.example.test/authorize",
    );
  });

  test.each([
    "javascript:alert(1)",
    "data:text/plain,owned",
    "file:///tmp/owned",
    "https://user:password@example.test/authorize",
    "https://login.example.test/authorize#fragment",
  ])("rejects unsafe endpoint %s", (value) => {
    expect(() => validateHttpUrl(value)).toThrow(DestinationPolicyError);
  });

  test("rejects HTTP by default and allows only explicit loopback HTTP", () => {
    expect(() => validateHttpUrl("http://127.0.0.1:4312/authorize")).toThrow(/must use https/i);
    expect(validateHttpUrl("http://127.0.0.1:4312/authorize", { allowLoopbackHttp: true })).toBe(
      "http://127.0.0.1:4312/authorize",
    );
    expect(() =>
      validateHttpUrl("http://provider.example.test/authorize", { allowLoopbackHttp: true }),
    ).toThrow(/must use https/i);
  });
});

function fakeDispatcher(): DispatcherLifecycle {
  return { close: () => {}, destroy: () => {} };
}

function lifecycle(): {
  dispatcher: DispatcherLifecycle;
  closed: number;
  destroyed: number;
} {
  const state = { closed: 0, destroyed: 0 };
  return {
    get dispatcher() {
      return {
        close: () => {
          state.closed += 1;
        },
        destroy: () => {
          state.destroyed += 1;
        },
      };
    },
    get closed() {
      return state.closed;
    },
    get destroyed() {
      return state.destroyed;
    },
  };
}
