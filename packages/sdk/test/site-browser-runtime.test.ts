import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { SITE_BROWSER_RUNTIME } from "../src/site-browser-runtime.gen";
import { SiteBridgeHost } from "../src/site-bridge-host";
import {
  createSiteToolBridge,
  siteSessionPath,
  type OpenGeniSiteClient,
  type OpenGeniSiteClientOptions,
} from "../src/site";

// Execute the checked-in bytes, never the entrypoint or a freshly built substitute.
// Package builds regenerate this file, so CI also checks freshness before builds.
function fixture(transport: "console" | "preview", response?: () => Response) {
  const requests: Array<{ path: string; headers: Headers }> = [];
  const fetchResponse = async (path: string, init?: RequestInit) => {
    requests.push({ path, headers: new Headers(init?.headers) });
    if (response) return response();
    const query = new URL(path, "https://host.invalid").searchParams;
    const filter = query.has("siteAccessId") ? "siteAccessId" : "originSiteId";
    return Response.json({
      pinned: [],
      sessions: [],
      nextCursor: null,
      filtersApplied: true,
      [filter]: query.get(filter),
    });
  };
  const realm: Record<string, unknown> = {
    MessageChannel,
    AbortController,
    DOMException,
    Headers,
    Request,
    Response,
    ReadableStream,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(SITE_BROWSER_RUNTIME, realm);
  const create = realm.createOpenGeniSiteClient as (
    options: OpenGeniSiteClientOptions,
  ) => OpenGeniSiteClient;
  let host: SiteBridgeHost | undefined;
  let bootstrap: MessagePort | undefined;
  let site: OpenGeniSiteClient;
  if (transport === "console") {
    const bridge = createSiteToolBridge({
      workspaceId: "workspace",
      artifactId: "pinned-site",
      siteVersionId: "pinned-version",
      requestedTools: [],
      workspaceTools: {
        $catalog: async () => ({
          version: 1,
          generation: 1,
          digest: "a".repeat(64),
          accountId: "account",
          workspaceId: "workspace",
          createdAt: "2026-10-19T00:00:00.000Z",
          entries: [],
        }),
      },
      callTool: async () => {
        throw new Error("Unexpected tool invocation");
      },
      fetchResponse,
    });
    host = new SiteBridgeHost({ tools: () => bridge });
    host.load({
      postMessage: (_message: unknown, _origin: string, transfer?: Transferable[]) => {
        bootstrap = transfer?.[0] as MessagePort;
      },
    } as Pick<Window, "postMessage">);
    site = create({ bootstrapPort: bootstrap!, connectTimeoutMs: 2_000 });
  } else {
    site = create({
      localCodemodePath: "/__opengeni/site-tools",
      fetch: (async (input, init) => {
        const path = String(input).replace("/__opengeni/site-tools/sdk", "");
        return fetchResponse(siteSessionPath(path, "workspace", init?.method), init);
      }) as typeof fetch,
    });
  }
  return {
    site,
    requests,
    close: () => {
      site.close();
      host?.close();
      bootstrap?.close();
    },
  };
}

describe.each(["console", "preview"] as const)("shipped Site runtime via %s", (transport) => {
  for (const filter of ["siteAccessId", "originSiteId"] as const) {
    test(`${filter}=current reaches only the host-bound Site`, async () => {
      const f = fixture(transport);
      try {
        const page = await f.site.client.listSessionPage(f.site.workspaceId, {
          [filter]: "current",
        });
        const boundSite =
          transport === "console" ? "pinned-site" : "00000000-0000-0000-0000-000000000000";
        expect(page).toEqual({
          pinned: [],
          sessions: [],
          nextCursor: null,
          filtersApplied: true,
          [filter]: boundSite,
        });
        expect(f.requests).toHaveLength(1);
        const url = new URL(f.requests[0]!.path, "https://host.invalid");
        expect(url.pathname).toBe("/v1/workspaces/workspace/sessions");
        expect([...url.searchParams]).toEqual([
          ["view", "page"],
          [filter, boundSite],
        ]);
        if (transport === "console") {
          expect(f.requests[0]!.headers.get("x-opengeni-site-id")).toBe("pinned-site");
          expect(f.requests[0]!.headers.get("x-opengeni-site-version")).toBe("pinned-version");
        }
      } finally {
        f.close();
      }
    });
  }

  test("unscoped, foreign, mixed filters and grant management never reach the host", async () => {
    const f = fixture(transport);
    try {
      for (const options of [
        {},
        { siteAccessId: "other-site" },
        { originSiteId: "other-site" },
        { siteAccessId: "current", originSiteId: "current" },
      ]) {
        await expect(
          f.site.client.listSessionPage(f.site.workspaceId, options),
        ).rejects.toMatchObject({ name: "SiteSessionPathError" });
      }
      await expect(
        f.site.client.listSessionPage("other-workspace", { siteAccessId: "current" }),
      ).rejects.toMatchObject({ name: "SiteSessionPathError" });
      await expect(
        f.site.client.listSiteSessionAccess(f.site.workspaceId, "current"),
      ).rejects.toMatchObject({ name: "SiteSessionPathError" });
      await expect(
        f.site.client.setSiteSessionAccess(f.site.workspaceId, "current", "session", true),
      ).rejects.toMatchObject({ code: "network_error", outcomeUnknown: true });
      // The SDK conservatively wraps mutation transport errors; still no request
      // leaves this frame and there is no automatic replay.
      expect(f.requests).toEqual([]);
    } finally {
      f.close();
    }
  });

  test("composer configuration stays workspace-scoped and refuses a foreign scope", async () => {
    const config = { allowedModels: [] };
    const f = fixture(transport, () => Response.json(config));
    try {
      expect(
        await f.site.client.getClientConfig({ workspaceId: f.site.workspaceId }),
      ).toMatchObject(config);
      expect(f.requests.map(({ path }) => path)).toEqual([
        "/v1/config/client?workspaceId=workspace",
      ]);
      await expect(
        f.site.client.getClientConfig({ workspaceId: "other-workspace" }),
      ).rejects.toMatchObject({ name: "SiteSessionPathError" });
      expect(f.requests).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  test("an API that ignores the access filter cannot silently widen the list", async () => {
    const f = fixture(transport, () =>
      Response.json({ pinned: [], sessions: [], nextCursor: null, filtersApplied: true }),
    );
    try {
      await expect(
        f.site.client.listSessionPage(f.site.workspaceId, { siteAccessId: "current" }),
      ).rejects.toThrow("Site access-filtered session lists");
      expect(f.requests).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  for (const status of [403, 404, 500]) {
    test(`host ${status} remains an error without replay`, async () => {
      const f = fixture(transport, () =>
        Response.json({ error: { code: "denied", message: "Host refused" } }, { status }),
      );
      try {
        await expect(
          f.site.client.listSessionPage(f.site.workspaceId, { siteAccessId: "current" }),
        ).rejects.toMatchObject({ status, code: "denied" });
        expect(f.requests).toHaveLength(1);
      } finally {
        f.close();
      }
    });
  }
});
