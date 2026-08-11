import { describe, expect, test } from "bun:test";
import { ExternalProviderCdpRunner } from "../src";

describe("ExternalProviderCdpRunner", () => {
  test("provisions one Kernel browser with an exact proxy id and releases it once", async () => {
    const requests: Request[] = [];
    const runner = new ExternalProviderCdpRunner({
      providerId: "kernel",
      apiKey: "kernel-private-key",
      endpoint: "https://kernel.example.test/root",
      headed: false,
      timeoutSeconds: 417,
      stealth: true,
      route: {
        providerId: "kernel",
        routeId: "proxy-route-9",
        egressClass: "isp",
        region: "NO",
      },
      fetch: stubFetch(requests, (request) => {
        if (request.method === "POST") {
          return Response.json(
            {
              session_id: "kernel-session-private",
              cdp_ws_url: "wss://kernel.example.test/devtools?token=private",
            },
            { status: 201 },
          );
        }
        return new Response(null, { status: 204 });
      }),
    });

    const [first, second] = await Promise.all([
      runner.run<{ cdpUrl: string }>(["get", "cdp-url"]),
      runner.run<{ cdpUrl: string }>(["get", "cdp-url"]),
    ]);
    expect(first).toEqual({
      cdpUrl: "wss://kernel.example.test/devtools?token=private",
    });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer kernel-private-key");
    expect(await requests[0]?.json()).toEqual({
      headless: true,
      stealth: true,
      timeout_seconds: 417,
      proxy_id: "proxy-route-9",
    });

    await Promise.all([runner.terminate(), runner.terminate()]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.url).toBe(
      "https://kernel.example.test/root/browsers/kernel-session-private",
    );
  });

  test("maps Browserbase's default residential route and country without inventing ids", async () => {
    const requests: Request[] = [];
    const runner = new ExternalProviderCdpRunner({
      providerId: "browserbase",
      apiKey: "browserbase-private-key",
      endpoint: "https://browserbase.example.test/v1",
      headed: true,
      route: {
        providerId: "browserbase",
        routeId: "default",
        egressClass: "residential",
        region: "no",
      },
      fetch: stubFetch(requests, (request) =>
        request.method === "POST" && request.url.endsWith("/sessions")
          ? Response.json(
              {
                id: "browserbase-session-private",
                connectUrl: "wss://connect.browserbase.example.test?token=private",
              },
              { status: 201 },
            )
          : Response.json({ status: "COMPLETED" }),
      ),
    });

    expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
      cdpUrl: "wss://connect.browserbase.example.test/?token=private",
    });
    expect(await requests[0]?.json()).toEqual({
      keepAlive: false,
      proxies: [{ type: "browserbase", geolocation: { country: "NO" } }],
    });
    expect(requests[0]?.headers.get("x-bb-api-key")).toBe("browserbase-private-key");

    await runner.terminate();
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe(
      "https://browserbase.example.test/v1/sessions/browserbase-session-private",
    );
    expect(await requests[1]?.json()).toEqual({ status: "REQUEST_RELEASE" });
  });

  test("rejects provider mismatches and unsupported Browserbase guarantees before I/O", () => {
    expect(
      () =>
        new ExternalProviderCdpRunner({
          providerId: "kernel",
          apiKey: "secret",
          headed: false,
          route: {
            providerId: "browserbase",
            routeId: "default",
            egressClass: "residential",
            region: null,
          },
        }),
    ).toThrow("another browser provider");
    expect(
      () =>
        new ExternalProviderCdpRunner({
          providerId: "browserbase",
          apiKey: "secret",
          headed: false,
          route: {
            providerId: "browserbase",
            routeId: "named-route",
            egressClass: "datacenter",
            region: "Europe/Oslo",
          },
        }),
    ).toThrow("default managed residential route");
  });
});

function stubFetch(requests: Request[], respond: (request: Request) => Response): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return respond(request);
  }) as typeof fetch;
}
