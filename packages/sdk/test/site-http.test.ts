import { expect, test } from "bun:test";
import { sitePortFetch, serveSiteHttp, siteSessionPath, isSiteHttpRequest } from "../src/site-http";
import { createOpenGeniSiteClient } from "../src/site";

test("HEAD and OPTIONS pass the published message validator; Site routing refuses them", async () => {
  for (const method of ["HEAD", "OPTIONS"]) {
    expect(
      isSiteHttpRequest({
        type: "opengeni.site.http",
        requestId: "one",
        path: "/v1/workspaces/site-host/sessions/one",
        headers: [],
        method,
      }),
    ).toBe(true);
    const channel = new MessageChannel();
    let posted = 0;
    channel.port2.onmessage = () => {
      posted += 1;
    };
    await expect(
      sitePortFetch(channel.port1, "https://site.test/v1/workspaces/site-host/sessions/one", {
        method,
      }),
    ).rejects.toThrow("Unsupported");
    expect(posted).toBe(0);
    channel.port1.close();
    channel.port2.close();
  }
});

test("malformed HTTP methods are rejected", () => {
  for (const method of ["", "GET\r\nX: bad", "G ET", null, 12]) {
    expect(
      isSiteHttpRequest({
        type: "opengeni.site.http",
        requestId: "one",
        path: "/v1/config/client",
        headers: [],
        method,
      }),
    ).toBe(false);
  }
});

test("Site SDK routing cannot change workspace or escape the host API", () => {
  expect(siteSessionPath("/v1/workspaces/site-host/sessions/one/events?after=4", "ws")).toBe(
    "/v1/workspaces/ws/sessions/one/events?after=4",
  );
  for (const path of [
    "https://evil.test/",
    "/v1/workspaces/other/sessions",
    "/v1/workspaces/site-host/sessions/../billing",
    "/v1/workspaces/site-host/sessions/%2e%2e/billing",
    "/v1/workspaces/site-host/projects",
    "/v1/workspaces/site-host/scheduled-tasks",
  ]) {
    expect(() => siteSessionPath(path, "ws")).toThrow();
  }
});

test("ordinary SDK session requests work through local preview transport", async () => {
  const paths: string[] = [];
  const site = createOpenGeniSiteClient({
    localCodemodePath: "/__opengeni/site-tools",
    fetch: (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return Response.json({ id: "one" });
    }) as typeof fetch,
  });
  expect(await site.client.getSession(site.workspaceId, "one")).toMatchObject({ id: "one" });
  expect(paths).toEqual(["/__opengeni/site-tools/sdk/v1/workspaces/site-host/sessions/one"]);
  site.close();
});

test("MessagePort fetch delivers SSE before completion and cancels upstream", async () => {
  const channel = new MessageChannel();
  const upstream = new AbortController();
  let serving: Promise<void> | undefined;
  channel.port2.onmessage = (event) => {
    if (event.data.type === "opengeni.site.cancel") {
      upstream.abort();
      return;
    }
    serving = serveSiteHttp(
      event.data,
      event.ports[0]!,
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: live\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      upstream.signal,
    );
  };
  const abort = new AbortController();
  const response = await sitePortFetch(
    channel.port1,
    "https://site.test/v1/workspaces/site-host/sessions/one/events/stream",
    { signal: abort.signal },
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: live\n\n");
  abort.abort();
  await expect(reader.read()).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(upstream.signal.aborted).toBe(true);
  await serving;
  channel.port1.close();
  channel.port2.close();
});

test("routes outside SITE_OPERATIONS never leave the Site; allowed ones keep API errors", async () => {
  const channel = new MessageChannel();
  const paths: string[] = [];
  channel.port2.onmessage = (event) => {
    paths.push(event.data.path);
    void serveSiteHttp(
      event.data,
      event.ports[0]!,
      async () => Response.json({ error: { message: "No access" } }, { status: 403 }),
      new AbortController().signal,
    );
  };
  await expect(
    sitePortFetch(channel.port1, "https://site.test/v1/workspaces/site-host/sessions/one/goal", {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    }),
  ).rejects.toThrow("Unsupported");
  const response = await sitePortFetch(
    channel.port1,
    "https://site.test/v1/workspaces/site-host/sessions/one/control",
    { method: "POST", body: JSON.stringify({ action: "pause" }) },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { message: "No access" } });
  expect(paths).toEqual(["/v1/workspaces/site-host/sessions/one/control"]);
  channel.port1.close();
  channel.port2.close();
});
