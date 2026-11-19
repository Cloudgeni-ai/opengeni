import { describe, expect, test } from "bun:test";
import type { SiteViewer } from "@opengeni/contracts";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_VERSION,
  createOpenGeniSiteClient,
  isOpenGeniSiteBridgeRequestMessage,
} from "../src/site";
import {
  SiteBridgeHost,
  injectSiteBridgeBootstrap,
  siteBridgeError,
  siteBridgeReadyMessage,
  type SiteBridgeToolHandlers,
  type SiteBridgeViewerHandlers,
} from "../src/site-bridge-host";

const member: SiteViewer = {
  kind: "member",
  id: "user:abc",
  name: "Ada",
  email: "ada@example.com",
  signedIn: true,
};

const catalog = {
  version: 1 as const,
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-10-14T00:00:00.000Z",
  entries: [],
};

/** Load a host into a fake frame window and connect an SDK client through the bootstrap port. */
function connect(source: ConstructorParameters<typeof SiteBridgeHost>[0]): {
  host: SiteBridgeHost;
  site: ReturnType<typeof createOpenGeniSiteClient>;
} {
  const host = new SiteBridgeHost(source);
  let bootstrap: MessagePort | undefined;
  const loaded = host.load({
    postMessage: (message: unknown, _origin: string, transfer?: Transferable[]) => {
      expect(message).toEqual({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
      bootstrap = transfer?.[0] as MessagePort;
    },
  } as Pick<Window, "postMessage">);
  expect(loaded).toBe(true);
  const site = createOpenGeniSiteClient({ bootstrapPort: bootstrap!, connectTimeoutMs: 2000 });
  return { host, site };
}

const tools: SiteBridgeToolHandlers = {
  catalog: async () => catalog,
  call: async () => {
    throw new Error("unused");
  },
};

describe("Site bridge host", () => {
  test("answers viewer and sign-in, advertises viewer: 1 and caches the viewer", async () => {
    let viewerCalls = 0;
    let signIns = 0;
    const viewer: SiteBridgeViewerHandlers = {
      viewer: () => {
        viewerCalls += 1;
        return member;
      },
      signIn: async () => {
        signIns += 1;
        return { started: true };
      },
    };
    expect(siteBridgeReadyMessage(tools, viewer)).toEqual({
      type: OPENGENI_SITE_BRIDGE_READY,
      version: OPENGENI_SITE_BRIDGE_VERSION,
      viewer: 1,
    });
    const { host, site } = connect({ tools: () => tools, viewer: () => viewer });
    try {
      expect(await site.viewer).toEqual(member);
      expect(await site.viewer).toEqual(member);
      expect(viewerCalls).toBe(1);
      expect(await site.auth.signIn()).toEqual({ started: true });
      expect(signIns).toBe(1);
      // Tools keep working next to the viewer methods.
      expect(await site.tools.$catalog()).toMatchObject({ digest: catalog.digest });
    } finally {
      site.close();
      host.close();
    }
  });

  test("hosts without viewers resolve null and never start a sign-in", async () => {
    const { host, site } = connect({ tools: () => tools });
    try {
      expect(await site.viewer).toBeNull();
      expect(await site.auth.signIn()).toEqual({ started: false });
    } finally {
      site.close();
      host.close();
    }
  });

  test("sign-in defaults to not started and a failed viewer lookup is retried", async () => {
    let attempts = 0;
    const viewer: SiteBridgeViewerHandlers = {
      viewer: async () => {
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error("try again"), { code: "site_upstream_unavailable" });
        return {
          ...member,
          kind: "guest",
          id: "guest:v1",
          name: null,
          email: null,
          signedIn: false,
        };
      },
    };
    const { host, site } = connect({ tools: () => undefined, viewer: () => viewer });
    try {
      await expect(site.viewer).rejects.toMatchObject({ code: "site_upstream_unavailable" });
      expect(await site.viewer).toMatchObject({ kind: "guest", signedIn: false });
      expect(await site.auth.signIn()).toEqual({ started: false });
    } finally {
      site.close();
      host.close();
    }
  });

  test("an invalid viewer from the host is refused", async () => {
    const { host, site } = connect({
      tools: () => undefined,
      viewer: () => ({ viewer: () => ({ kind: "root", id: "" }) as unknown as SiteViewer }),
    });
    try {
      await expect(site.viewer).rejects.toMatchObject({ code: "invalid_viewer" });
    } finally {
      site.close();
      host.close();
    }
  });

  test("serves the Site HTTP channel through the injected handler", async () => {
    const seen: string[] = [];
    const handlers: SiteBridgeToolHandlers = {
      ...tools,
      siteData: true,
      fetch: async (request) => {
        seen.push(`${request.method} ${request.path}`);
        return Response.json({ files: [], nextCursor: null });
      },
    };
    const { host, site } = connect({ tools: () => handlers });
    try {
      expect(await site.files.list()).toEqual({ files: [], nextCursor: null });
      expect(seen).toEqual(["GET /v1/workspaces/site-host/published-artifacts/current/files"]);
    } finally {
      site.close();
      host.close();
    }
  });

  test("a second document load revokes the bridge", () => {
    const host = new SiteBridgeHost({ tools: () => tools });
    const frame = { postMessage: () => undefined } as Pick<Window, "postMessage">;
    expect(host.load(frame)).toBe(true);
    expect(host.load(frame)).toBe(false);
    host.close();
  });

  test("viewer methods are bridge requests and the bootstrap follows the doctype", () => {
    for (const method of ["viewer", "auth.signIn"])
      expect(
        isOpenGeniSiteBridgeRequestMessage({
          type: "opengeni.site.request",
          version: 2,
          requestId: "r1",
          method,
        }),
      ).toBe(true);
    const document = injectSiteBridgeBootstrap("<!-- c --><!doctype html><p>x</p>");
    expect(document.startsWith("<!-- c --><!doctype html><script>")).toBe(true);
    expect(injectSiteBridgeBootstrap("<p>x</p>").startsWith("<script>")).toBe(true);
  });
});

describe("Site data hints through the bridge host", () => {
  test("a host following data hints advertises them and each collection hears its own", async () => {
    let push: ((change: { collections: string[] | null; seq: number | null }) => void) | undefined;
    const live: SiteBridgeToolHandlers = {
      ...tools,
      fetch: async () => new Response("{}"),
      siteData: true,
      subscribeDataChanges: (listener) => {
        push = listener;
        return () => {
          push = undefined;
        };
      },
    };
    expect(siteBridgeReadyMessage(live)).toMatchObject({ dataChanges: 1 });
    expect(
      siteBridgeReadyMessage({ ...tools, fetch: live.fetch!, siteData: true }),
    ).not.toHaveProperty("dataChanges");
    const { host, site } = connect({ tools: () => live });
    try {
      const all: unknown[] = [];
      const todos: unknown[] = [];
      const heardAll = new Promise<void>((resolve) => {
        site.data.onChange((change) => {
          all.push(change);
          if (all.length === 2) resolve();
        });
      });
      site.data.collection("todos").onChange((change) => todos.push(change));
      // Wait for the client to connect and the host to follow.
      const following = () => push !== undefined;
      for (let i = 0; i < 50 && !following(); i++) await new Promise((r) => setTimeout(r, 10));
      push!({ collections: ["notes"], seq: 2 });
      host.notifyDataChanged({ collections: null, seq: 3 });
      await heardAll;
      expect(all).toEqual([
        { collections: ["notes"], seq: 2 },
        { collections: null, seq: 3 },
      ]);
      expect(todos).toEqual([{ collections: null, seq: 3 }]);
    } finally {
      site.close();
      host.close();
    }
    expect(push).toBeUndefined();
  });
});

describe("Site tool readiness through the bridge host", () => {
  const target = { identity: { serverId: "crm", toolName: "update" } };
  const answer = {
    version: 1 as const,
    tools: [
      {
        target,
        state: "connect" as const,
        confirm: "never" as const,
        runsAs: null,
        connector: "CRM",
      },
    ],
  };

  test("answers $readiness and tells the Site when it may have changed", async () => {
    const seen: unknown[] = [];
    let changed: (() => void) | undefined;
    const ready: SiteBridgeToolHandlers = {
      ...tools,
      readiness: async (request) => {
        seen.push(request);
        return answer;
      },
      subscribeReadiness: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    };
    expect(siteBridgeReadyMessage(ready)).toMatchObject({ toolReadiness: 1 });
    const { host, site } = connect({ tools: () => ready });
    try {
      expect(await site.tools.$readiness([target])).toEqual(answer);
      expect(seen).toEqual([{ targets: [target] }]);
      let heard = 0;
      const heardOnce = new Promise<void>((resolve) => {
        site.tools.$onReadinessChange(() => {
          heard += 1;
          resolve();
        });
      });
      changed!();
      await heardOnce;
      expect(heard).toBe(1);
    } finally {
      site.close();
      host.close();
    }
    expect(changed).toBeUndefined();
  });

  test("a host without readiness refuses it with readiness_unsupported", async () => {
    expect(siteBridgeReadyMessage(tools)).not.toHaveProperty("toolReadiness");
    const { host, site } = connect({ tools: () => tools });
    try {
      const error = await site.tools.$readiness([target]).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "readiness_unsupported" });
    } finally {
      site.close();
      host.close();
    }
  });

  test("typed server answers reach Site code as their site_tool codes", () => {
    expect(
      siteBridgeError({
        code: "forbidden",
        message: "tool_blocked",
        details: { code: "tool_blocked" },
      }),
    ).toMatchObject({ code: "site_tool_blocked", retryable: false, outcomeUnknown: false });
    expect(
      siteBridgeError({
        code: "conflict",
        message: "x",
        details: { code: "site_tool_consent_requires_opengeni" },
      }),
    ).toMatchObject({ code: "site_tool_open_in_opengeni", retryable: false });
    expect(
      siteBridgeError({
        code: "upstream_unavailable",
        message: "x",
        retryable: true,
        outcomeUnknown: false,
        details: { code: "tool_server_unreachable" },
      }),
    ).toMatchObject({ code: "site_tool_upstream_unavailable", retryable: true });
    // Without proof that nothing was sent, it is never presented as retryable.
    expect(
      siteBridgeError({
        code: "upstream_unavailable",
        message: "x",
        outcomeUnknown: true,
        details: { code: "tool_server_unreachable" },
      }),
    ).toMatchObject({ code: "upstream_unavailable", retryable: false, outcomeUnknown: true });
  });
});
