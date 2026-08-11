import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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

  test("omits provider routing fields when external placement uses direct egress", async () => {
    const kernelRequests: Request[] = [];
    const kernel = new ExternalProviderCdpRunner({
      providerId: "kernel",
      apiKey: "kernel-private-key",
      headed: false,
      fetch: stubFetch(kernelRequests, (request) =>
        request.method === "POST"
          ? Response.json({
              session_id: "kernel-direct",
              cdp_ws_url: "wss://kernel.example.test/direct",
            })
          : new Response(null, { status: 204 }),
      ),
    });
    await kernel.run(["get", "cdp-url"]);
    expect(await kernelRequests[0]?.json()).toEqual({ headless: true });
    await kernel.terminate();

    const browserbaseRequests: Request[] = [];
    const browserbase = new ExternalProviderCdpRunner({
      providerId: "browserbase",
      apiKey: "browserbase-private-key",
      headed: false,
      fetch: stubFetch(browserbaseRequests, (request) =>
        request.url.endsWith("/sessions") && request.method === "POST"
          ? Response.json({
              id: "browserbase-direct",
              connectUrl: "wss://browserbase.example.test/direct",
            })
          : Response.json({ status: "COMPLETED" }),
      ),
    });
    await browserbase.run(["get", "cdp-url"]);
    expect(await browserbaseRequests[0]?.json()).toEqual({ keepAlive: false });
    await browserbase.terminate();
  });

  test("advances Kernel managed auth, gates its hosted URL, and attaches the profile once", async () => {
    const requests: Request[] = [];
    let connectionReads = 0;
    const runner = new ExternalProviderCdpRunner({
      providerId: "kernel",
      apiKey: "kernel-private-key",
      endpoint: "https://kernel.example.test",
      headed: false,
      fetch: stubFetch(requests, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/browsers" && request.method === "POST") {
          return Response.json({
            session_id: "browser-1",
            cdp_ws_url: "wss://kernel.example.test/cdp-before",
          });
        }
        if (url.pathname === "/auth/connections/connection-1/login") {
          return Response.json({ hosted_url: "https://auth.kernel.example.test/flow/private" });
        }
        if (url.pathname === "/auth/connections/connection-1") {
          connectionReads += 1;
          if (connectionReads <= 3) {
            return Response.json({
              status: "NEEDS_AUTH",
              flow_status: connectionReads === 1 ? null : "IN_PROGRESS",
              flow_step: connectionReads === 1 ? null : "AWAITING_INPUT",
              external_action_message: "Complete sign-in securely",
              hosted_url: "https://auth.kernel.example.test/flow/private",
            });
          }
          return Response.json({
            status: "AUTHENTICATED",
            flow_status: "SUCCESS",
            profile_name: "managed-profile-1",
          });
        }
        if (url.pathname === "/browsers/browser-1" && request.method === "PATCH") {
          return Response.json({
            session_id: "browser-1",
            cdp_ws_url: "wss://kernel.example.test/cdp-after",
          });
        }
        if (url.pathname === "/browsers/browser-1" && request.method === "GET") {
          return Response.json({
            session_id: "browser-1",
            cdp_ws_url: "wss://kernel.example.test/cdp-before",
            profile: null,
          });
        }
        if (url.pathname === "/browsers/browser-1" && request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      }),
    });
    expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
      cdpUrl: "wss://kernel.example.test/cdp-before",
    });
    const base = {
      browserSessionId: randomUUID(),
      controllerGeneration: "controller-1",
      authRunId: randomUUID(),
      adapterId: "kernel",
      connectionId: "connection-1",
    } as const;
    const started = await runner.externalAuth({
      ...base,
      operationId: randomUUID(),
      action: "start",
    });
    expect(started).toMatchObject({
      result: { state: "needs_human", interactiveUrl: null, profileLoaded: false },
      browserReconfigured: false,
    });
    const interactive = await runner.externalAuth({
      ...base,
      operationId: randomUUID(),
      action: "interactive",
    });
    expect(interactive.result.interactiveUrl).toBe("https://auth.kernel.example.test/flow/private");
    const pollOperationId = randomUUID();
    const authenticated = await runner.externalAuth({
      ...base,
      operationId: pollOperationId,
      action: "poll",
    });
    expect(authenticated).toEqual({
      result: {
        state: "authenticated",
        externalAction: null,
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: true,
      },
      browserReconfigured: true,
    });
    expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
      cdpUrl: "wss://kernel.example.test/cdp-after",
    });
    const patch = requests.find(
      (request) => request.method === "PATCH" && request.url.endsWith("/browsers/browser-1"),
    );
    expect(await patch?.json()).toEqual({ profile: { name: "managed-profile-1" } });
    const requestCount = requests.length;
    expect(
      await runner.externalAuth({
        ...base,
        operationId: pollOperationId,
        action: "poll",
      }),
    ).toEqual(authenticated);
    expect(requests).toHaveLength(requestCount);
    await runner.terminate();
  });

  test("never attaches an authenticated profile while only revealing the human flow", async () => {
    const requests: Request[] = [];
    const runner = new ExternalProviderCdpRunner({
      providerId: "kernel",
      apiKey: "kernel-private-key",
      endpoint: "https://kernel.example.test",
      headed: false,
      fetch: stubFetch(requests, (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/browsers" && request.method === "POST") {
          return Response.json({
            session_id: "browser-1",
            cdp_ws_url: "wss://kernel.example.test/cdp-before",
          });
        }
        if (pathname === "/auth/connections/connection-1") {
          return Response.json({
            status: "AUTHENTICATED",
            flow_status: "SUCCESS",
            profile_name: "managed-profile-1",
          });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      }),
    });
    await runner.run(["get", "cdp-url"]);
    expect(
      await runner.externalAuth({
        browserSessionId: randomUUID(),
        controllerGeneration: "controller-1",
        operationId: randomUUID(),
        authRunId: randomUUID(),
        adapterId: "kernel",
        connectionId: "connection-1",
        action: "interactive",
      }),
    ).toEqual({
      result: {
        state: "authenticated",
        externalAction: null,
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: false,
      },
      browserReconfigured: false,
    });
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  test("recovers an already-attached Kernel profile after the attach reply is lost", async () => {
    const requests: Request[] = [];
    let profileAttached = false;
    const request = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const captured = new Request(input, init);
      requests.push(captured.clone());
      const { pathname } = new URL(captured.url);
      if (pathname === "/browsers" && captured.method === "POST") {
        return Response.json({
          session_id: "browser-1",
          cdp_ws_url: "wss://kernel.example.test/cdp-before",
        });
      }
      if (pathname === "/auth/connections/connection-1") {
        return Response.json({
          status: "AUTHENTICATED",
          flow_status: "SUCCESS",
          profile_name: "managed-profile-1",
        });
      }
      if (pathname === "/browsers/browser-1" && captured.method === "GET") {
        return Response.json({
          session_id: "browser-1",
          cdp_ws_url: profileAttached
            ? "wss://kernel.example.test/cdp-after"
            : "wss://kernel.example.test/cdp-before",
          profile: profileAttached ? { name: "managed-profile-1" } : null,
        });
      }
      if (pathname === "/browsers/browser-1" && captured.method === "PATCH") {
        profileAttached = true;
        throw new TypeError("provider reply was lost");
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const runner = new ExternalProviderCdpRunner({
      providerId: "kernel",
      apiKey: "kernel-private-key",
      endpoint: "https://kernel.example.test",
      headed: false,
      fetch: request,
    });
    await runner.run(["get", "cdp-url"]);
    const command = {
      browserSessionId: randomUUID(),
      controllerGeneration: "controller-1",
      operationId: randomUUID(),
      authRunId: randomUUID(),
      adapterId: "kernel",
      connectionId: "connection-1",
      action: "poll" as const,
    };
    await expect(runner.externalAuth(command)).rejects.toThrow(
      "profile load could not reach the provider",
    );
    expect(await runner.externalAuth(command)).toEqual({
      result: {
        state: "authenticated",
        externalAction: null,
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: true,
      },
      browserReconfigured: true,
    });
    expect(requests.filter((captured) => captured.method === "PATCH")).toHaveLength(1);
    expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
      cdpUrl: "wss://kernel.example.test/cdp-after",
    });
  });

  test("rejects managed auth on Browserbase before provider I/O", async () => {
    const requests: Request[] = [];
    const runner = new ExternalProviderCdpRunner({
      providerId: "browserbase",
      apiKey: "browserbase-private-key",
      headed: false,
      fetch: stubFetch(requests, () => Response.json({})),
    });
    await expect(
      runner.externalAuth({
        browserSessionId: randomUUID(),
        controllerGeneration: "controller-1",
        operationId: randomUUID(),
        authRunId: randomUUID(),
        adapterId: "kernel",
        connectionId: "connection-1",
        action: "start",
      }),
    ).rejects.toThrow("does not support managed authentication");
    expect(requests).toHaveLength(0);
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
