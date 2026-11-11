import { describe, expect, test } from "bun:test";
import type { SiteHostMapRecord } from "@opengeni/contracts";
import { rateLimitKeys, underRateLimit } from "../src/api";
import { edgeCacheKey } from "../src/edge-cache";
import { HOST_MISS_CACHE_TTL, shouldWriteBack } from "../src/host-map";
import type { SiteContext } from "../src/site-context";
import { EDGE_HTML_TTL, isFrameLoad, siteFrameEtag } from "../src/version";

function record(generation: number, status: SiteHostMapRecord["status"]): SiteHostMapRecord {
  return {
    v: 1,
    hostname: "a-site.sites.test",
    siteId: "33333333-3333-4333-8333-333333333333",
    status,
    access: "public",
    versionId: null,
    title: "A",
    noindex: false,
    generation,
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
}

describe("gateway caches", () => {
  test("keys live on the real host, under the gateway-owned cache path", () => {
    expect(edgeCacheKey("a-site.sites.test", "site-html", [7, "s/1", "v"]).url).toBe(
      "https://a-site.sites.test/_og/cache/site-html/7/s%2F1/v",
    );
    expect(edgeCacheKey("a-site.sites.test", "host-miss").url).toBe(
      "https://a-site.sites.test/_og/cache/host-miss",
    );
  });

  test("write-back never replaces the same or a newer generation", () => {
    expect(shouldWriteBack(null, record(3, "active"))).toBe(true);
    expect(shouldWriteBack(record(2, "active"), record(3, "active"))).toBe(true);
    expect(shouldWriteBack(record(3, "active"), record(3, "active"))).toBe(false);
    expect(shouldWriteBack(record(5, "suspended"), record(4, "active"))).toBe(false);
    expect(shouldWriteBack(record(5, "suspended"), record(5, "active"))).toBe(false);
  });

  test("takedowns and first publishes are not masked for long", () => {
    expect(EDGE_HTML_TTL).toBeLessThanOrEqual(60);
    expect(HOST_MISS_CACHE_TTL).toBeLessThanOrEqual(10);
  });

  test("Site HTML refuses requests that say they are not iframe loads, with a stable ETag", async () => {
    const load = (dest?: string) =>
      new Request("https://a-site.sites.test/_og/v/x", {
        headers: dest ? { "sec-fetch-dest": dest } : {},
      });
    expect(isFrameLoad(load("iframe"))).toBe(true);
    expect(isFrameLoad(load("document"))).toBe(false);
    expect(isFrameLoad(load("empty"))).toBe(false);
    // No Fetch Metadata at all (older browsers): served, still sandboxed by its CSP.
    expect(isFrameLoad(load())).toBe(true);
    // Versions are immutable: the ETag names the Site, the version and the gateway's frame format,
    // so serving or revalidating a page never needs the page whole.
    const site = "33333333-3333-4333-8333-333333333333";
    const v1 = "11111111-1111-4111-8111-111111111111";
    const v2 = "22222222-2222-4222-8222-222222222222";
    expect(await siteFrameEtag(site, v1)).toBe(await siteFrameEtag(site, v1));
    expect(await siteFrameEtag(site, v1)).not.toBe(await siteFrameEtag(site, v2));
    expect(await siteFrameEtag(site, v1)).not.toBe(
      await siteFrameEtag("44444444-4444-4444-8444-444444444444", v1),
    );
    expect(await siteFrameEtag(site, v1)).toMatch(/^"[0-9a-f]{32}"$/u);
  });
});

describe("edge flood brake", () => {
  function site(blocked: string[], seen: string[]): SiteContext {
    return {
      hostname: "a-site.sites.test",
      visitor: "visitor-1",
      clientIp: "203.0.113.1",
      config: {
        rateLimiter: {
          limit: async ({ key }: { key: string }) => {
            seen.push(key);
            return { success: !blocked.some((prefix) => key.includes(prefix)) };
          },
        },
      },
    } as unknown as SiteContext;
  }

  test("both the client IP and the visitor must pass", async () => {
    const seen: string[] = [];
    expect(await underRateLimit(site([], seen))).toBe(true);
    expect(seen).toEqual(rateLimitKeys(site([], [])));
    // A fresh visitor cookie does not reset an exhausted IP budget.
    expect(await underRateLimit(site([":ip:"], []))).toBe(false);
    expect(await underRateLimit(site([":v:"], []))).toBe(false);
  });

  test("a failing binding never blocks traffic", async () => {
    const broken = {
      hostname: "a-site.sites.test",
      visitor: null,
      clientIp: "",
      config: {
        rateLimiter: {
          limit: async () => {
            throw new Error("binding unavailable");
          },
        },
      },
    } as unknown as SiteContext;
    expect(await underRateLimit(broken)).toBe(true);
  });
});
