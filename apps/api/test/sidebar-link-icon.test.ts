import { beforeEach, describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import type { PinnedFetchOptions } from "@opengeni/network";

import {
  readSidebarLinkIcon,
  resetSidebarLinkIcons,
  sniffSidebarLinkIcon,
} from "../src/sidebar-link-icon";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function site(upstream: (url: string) => Response) {
  const fetched: string[] = [];
  const options: PinnedFetchOptions = {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    agentFactory: () => ({ close() {}, destroy() {} }) as never,
    fetchImpl: async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return upstream(url);
    },
  };
  return { options, fetched };
}

beforeEach(() => resetSidebarLinkIcons());

describe("sidebar link icons", () => {
  test("sniffs raster icons and refuses anything else", () => {
    expect(sniffSidebarLinkIcon(PNG)).toBe("image/png");
    expect(sniffSidebarLinkIcon(ICO)).toBe("image/x-icon");
    expect(sniffSidebarLinkIcon(SVG)).toBeNull();
  });

  test("reads the site's favicon, follows https redirects and keeps the answer", async () => {
    const { options, fetched } = site((url) =>
      url.endsWith("/favicon.ico") && url.startsWith("https://docs.example.com")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://cdn.example.com/i.png" },
          })
        : new Response(PNG),
    );
    const settings = testSettings();
    const first = await readSidebarLinkIcon("https://docs.example.com/a/b?c", settings, options);
    expect(first?.contentType).toBe("image/png");
    expect(fetched).toEqual([
      "https://docs.example.com/favicon.ico",
      "https://cdn.example.com/i.png",
    ]);
    await readSidebarLinkIcon("https://docs.example.com/other", settings, options);
    expect(fetched).toHaveLength(2);
  });

  test("a site without a raster icon has none", async () => {
    const settings = testSettings();
    const svg = site(() => new Response(SVG));
    expect(await readSidebarLinkIcon("https://a.example.com", settings, svg.options)).toBeNull();
    const missing = site(() => new Response("no", { status: 404 }));
    expect(
      await readSidebarLinkIcon("https://b.example.com", settings, missing.options),
    ).toBeNull();
    const plain = site(
      () => new Response(null, { status: 302, headers: { location: "http://c.example.com/i" } }),
    );
    expect(await readSidebarLinkIcon("https://c.example.com", settings, plain.options)).toBeNull();
  });
});
