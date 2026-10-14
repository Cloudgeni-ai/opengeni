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
