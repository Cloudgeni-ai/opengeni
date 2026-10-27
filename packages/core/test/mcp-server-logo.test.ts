import { describe, expect, test } from "bun:test";

import {
  storeMcpServerLogo,
  type McpServerLogoFetch,
  type McpServerLogoStorage,
} from "../src/domain/mcp-server-logo";

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>';
const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function memoryStorage() {
  const objects = new Map<string, { contentType: string; body: Uint8Array }>();
  const storage: McpServerLogoStorage = {
    putObject: async (input) => {
      objects.set(input.key, {
        contentType: input.contentType ?? "",
        body: new Uint8Array(input.body as Uint8Array),
      });
      return { key: input.key } as Awaited<ReturnType<McpServerLogoStorage["putObject"]>>;
    },
  };
  return { storage, objects };
}

function routes(table: Record<string, () => Response>): {
  fetch: McpServerLogoFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(url);
      expect(init.redirect).toBe("manual");
      const route = table[url];
      return route ? route() : new Response("missing", { status: 404 });
    },
  };
}

const noFetch: McpServerLogoFetch = async () => {
  throw new Error("fetch not expected");
};

describe("storeMcpServerLogo", () => {
  test("stores a data URI icon under a digest key for the server's host", async () => {
    const { storage, objects } = memoryStorage();
    const key = await storeMcpServerLogo({
      serverInfo: {
        name: "messages",
        version: "1.0.0",
        icons: [
          {
            src: `data:image/svg+xml;base64,${Buffer.from(SAFE_SVG).toString("base64")}`,
            mimeType: "image/svg+xml",
          },
        ],
      },
      endpointUrl: "https://mcp.example.com/mcp",
      objectStorage: storage,
      fetch: noFetch,
    });
    expect(key).toMatch(/^catalog-assets\/mcp-icons\/mcp\.example\.com\/[0-9a-f]{24}\.svg$/);
    expect(new TextDecoder().decode(objects.get(key ?? "")?.body)).toBe(SAFE_SVG);
    expect(objects.get(key ?? "")?.contentType).toBe("image/svg+xml");
  });

  test("skips a scripted SVG and stores the next icon", async () => {
    const { storage, objects } = memoryStorage();
    const { fetch, calls } = routes({
      "https://cdn.example.com/logo.svg": () =>
        new Response(SCRIPTED_SVG, { headers: { "content-type": "image/svg+xml" } }),
      "https://cdn.example.com/logo.png": () =>
        new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    const key = await storeMcpServerLogo({
      serverInfo: {
        icons: [
          { src: "https://cdn.example.com/logo.png", sizes: ["128x128"] },
          { src: "https://cdn.example.com/logo.svg" },
        ],
      },
      endpointUrl: "https://mcp.example.com/mcp",
      objectStorage: storage,
      fetch,
    });
    expect(calls).toEqual(["https://cdn.example.com/logo.svg", "https://cdn.example.com/logo.png"]);
    expect(key).toMatch(/\.png$/);
    expect(Array.from(objects.get(key ?? "")?.body ?? [])).toEqual(Array.from(PNG));
  });

  test("follows an https redirect through the same fetch policy", async () => {
    const { storage } = memoryStorage();
    const { fetch, calls } = routes({
      "https://example.com/icon": () =>
        new Response(null, { status: 302, headers: { location: "/static/icon.png" } }),
      "https://example.com/static/icon.png": () =>
        new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    const key = await storeMcpServerLogo({
      serverInfo: { icons: [{ src: "https://example.com/icon", mimeType: "image/png" }] },
      endpointUrl: "https://mcp.example.com/mcp",
      objectStorage: storage,
      fetch,
    });
    expect(calls).toEqual(["https://example.com/icon", "https://example.com/static/icon.png"]);
    expect(key).toMatch(/\.png$/);
  });

  test("refuses a redirect to plain http and keeps the monogram", async () => {
    const { storage, objects } = memoryStorage();
    const { fetch } = routes({
      "https://example.com/icon.png": () =>
        new Response(null, { status: 301, headers: { location: "http://example.com/icon.png" } }),
    });
    const key = await storeMcpServerLogo({
      serverInfo: { icons: [{ src: "https://example.com/icon.png" }] },
      endpointUrl: "https://mcp.example.com/mcp",
      objectStorage: storage,
      fetch,
    });
    expect(key).toBeNull();
    expect(objects.size).toBe(0);
  });

  test("rejects oversized, non-image and failing icons and tries at most three", async () => {
    const { storage, objects } = memoryStorage();
    const { fetch, calls } = routes({
      "https://example.com/1.svg": () =>
        new Response("x", {
          headers: { "content-type": "image/svg+xml", "content-length": String(10_000_000) },
        }),
      "https://example.com/2.svg": () =>
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      "https://example.com/3.svg": () => new Response("down", { status: 503 }),
      "https://example.com/4.svg": () =>
        new Response(SAFE_SVG, { headers: { "content-type": "image/svg+xml" } }),
    });
    const key = await storeMcpServerLogo({
      serverInfo: {
        icons: [1, 2, 3, 4].map((n) => ({ src: `https://example.com/${n}.svg` })),
      },
      endpointUrl: "https://mcp.example.com/mcp",
      objectStorage: storage,
      fetch,
    });
    expect(key).toBeNull();
    expect(calls).toHaveLength(3);
    expect(objects.size).toBe(0);
  });

  test("does nothing without object storage or icons", async () => {
    expect(
      await storeMcpServerLogo({
        serverInfo: { icons: [{ src: "https://example.com/logo.svg" }] },
        endpointUrl: "https://mcp.example.com/mcp",
        objectStorage: null,
        fetch: noFetch,
      }),
    ).toBeNull();
    expect(
      await storeMcpServerLogo({
        serverInfo: { name: "plain", version: "1.0.0" },
        endpointUrl: "https://mcp.example.com/mcp",
        objectStorage: memoryStorage().storage,
        fetch: noFetch,
      }),
    ).toBeNull();
  });
});
