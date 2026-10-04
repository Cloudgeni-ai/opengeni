// `<OpenGeniChat baseUrl=... />` and `<SessionConversation baseUrl=... />`:
// no provider, client or workspace id in the browser. The component reads the
// workspace the session proxy resolved from its client config.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { SessionConversation } from "../src/components/session-conversation";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const RESOLVED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";

function sessionRecord() {
  const now = new Date().toISOString();
  return {
    id: SESSION,
    workspaceId: RESOLVED,
    title: "Quarterly report",
    titleSource: "user",
    status: "idle",
    initialMessage: "Quarterly report",
    createdAt: now,
    updatedAt: now,
  };
}

let requests: string[] = [];
let reportWorkspace = true;
let previousFetch: typeof globalThis.fetch;

/** A fake same-origin session proxy mounted at /api/opengeni. */
async function fakeProxy(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "https://product.test",
  );
  const method = init?.method ?? "GET";
  requests.push(`${method} ${url.pathname}`);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const base = "/api/opengeni/v1";
  if (url.pathname === `${base}/config/client`) {
    return json({
      deploymentRevision: "test",
      apiContractRevision: "proxy-revision",
      defaultModel: "scripted-model",
      allowedModels: [],
      models: [],
      fileUploads: { enabled: false, maxSizeBytes: 0 },
      ...(reportWorkspace ? { workspaceId: RESOLVED } : {}),
    });
  }
  if (url.pathname === `${base}/workspaces/${RESOLVED}`) return json({ id: RESOLVED });
  if (url.pathname === `${base}/workspaces/${RESOLVED}/sessions` && method === "GET") {
    // A full page; the client projects it for the list. Echo the requested view.
    return json({
      pinned: [],
      sessions: [sessionRecord()],
      nextCursor: null,
      sortBy: url.searchParams.get("sortBy") ?? undefined,
      archiveStatus: url.searchParams.get("archiveStatus") ?? undefined,
    });
  }
  if (url.pathname === `${base}/workspaces/${RESOLVED}/sessions/${SESSION}`) {
    return json(sessionRecord());
  }
  return json({ error: { code: "route_not_allowed", message: "Not found." } }, 404);
}

beforeEach(() => {
  requests = [];
  reportWorkspace = true;
  previousFetch = globalThis.fetch;
  globalThis.fetch = fakeProxy as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("session proxy baseUrl", () => {
  test("OpenGeniChat needs only the proxy baseUrl", async () => {
    const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" />);
    try {
      await flush(150);
      expect(requests[0]).toBe("GET /api/opengeni/v1/config/client");
      expect(requests).toContain(`GET /api/opengeni/v1/workspaces/${RESOLVED}/sessions`);
      expect(view.container.querySelector("[data-og-chat]")).not.toBeNull();
      expect(view.container.textContent).toContain("Quarterly report");
      // Every call stays on the proxy mount and in the resolved workspace.
      for (const request of requests) {
        const path = request.split(" ")[1]!;
        expect(path.startsWith("/api/opengeni/v1/")).toBe(true);
        if (path.includes("/workspaces/")) expect(path).toContain(`/workspaces/${RESOLVED}`);
      }
    } finally {
      await view.unmount();
    }
  });

  test("SessionConversation needs only the proxy baseUrl and a session id", async () => {
    const view = await renderComponent(
      <SessionConversation baseUrl="/api/opengeni" sessionId={SESSION} />,
    );
    try {
      await flush(150);
      expect(requests).toContain(`GET /api/opengeni/v1/workspaces/${RESOLVED}/sessions/${SESSION}`);
      expect(view.container.querySelector("[data-og-conversation]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("an explicit workspaceId skips the lookup", async () => {
    const view = await renderComponent(
      <OpenGeniChat baseUrl="/api/opengeni" workspaceId={RESOLVED} />,
    );
    try {
      await flush(150);
      expect(requests).toContain(`GET /api/opengeni/v1/workspaces/${RESOLVED}/sessions`);
      expect(view.container.textContent).toContain("Quarterly report");
    } finally {
      await view.unmount();
    }
  });

  test("bearer-token hosts add headers per request", async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return await fakeProxy(input, init);
    }) as typeof globalThis.fetch;
    const token = "t1";
    const view = await renderComponent(
      <OpenGeniChat
        baseUrl="/api/opengeni"
        headers={() => ({ Authorization: `Bearer ${token}` })}
      />,
    );
    try {
      await flush(150);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((value) => value === "Bearer t1")).toBe(true);
      expect(view.container.textContent).toContain("Quarterly report");
    } finally {
      await view.unmount();
    }
  });

  test("a custom fetch carries every proxy request", async () => {
    const custom: string[] = [];
    const view = await renderComponent(
      <SessionConversation
        baseUrl="/api/opengeni"
        sessionId={SESSION}
        fetch={async (input, init) => {
          custom.push(String(input));
          return await fakeProxy(input as RequestInfo, init);
        }}
      />,
    );
    try {
      await flush(150);
      expect(custom.length).toBeGreaterThan(0);
      expect(custom.length).toBe(requests.length);
      expect(view.container.querySelector("[data-og-conversation]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a client passed with baseUrl is used, not dropped", async () => {
    const used: string[] = [];
    const client = new OpenGeniBrowserClient({
      baseUrl: "/api/opengeni",
      apiContract: "compatible",
      fetch: async (input, init) => {
        used.push(String(input));
        return await fakeProxy(input as RequestInfo, init);
      },
    });
    const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" client={client} />);
    try {
      await flush(150);
      expect(used.some((url) => url.endsWith("/v1/config/client"))).toBe(true);
      expect(used.length).toBe(requests.length);
      expect(view.container.textContent).toContain("Quarterly report");
    } finally {
      await view.unmount();
    }
  });

  test("a proxy that does not report its workspace shows an actionable error", async () => {
    reportWorkspace = false;
    const view = await renderComponent(<OpenGeniChat baseUrl="/api/opengeni" />);
    try {
      await flush(100);
      const alert = view.container.querySelector("[data-og-proxy-error]");
      expect(alert?.textContent).toContain("Update @opengeni/sdk on the server");
      expect(requests.every((request) => !request.includes("/workspaces/"))).toBe(true);
    } finally {
      await view.unmount();
    }
  });
});
