import { describe, expect, test } from "bun:test";

import {
  SITE_PAGE_HEAVY_BYTES,
  SITE_PAGE_SERVED_MAX_BYTES,
  sitePageSizeWarnings,
  withSitePageSizeWarnings,
} from "../src/site-publishing/page-size";

describe("Site page size warnings", () => {
  test("an ordinary page has none, and its publish result is unchanged", () => {
    expect(sitePageSizeWarnings(40_000)).toEqual([]);
    expect(sitePageSizeWarnings(SITE_PAGE_HEAVY_BYTES)).toEqual([]);
    const result = { version: { sizeBytes: 40_000 }, replayed: false };
    expect(withSitePageSizeWarnings(result)).toBe(result);
    expect(withSitePageSizeWarnings(result)).not.toHaveProperty("warnings");
  });

  test("a heavy page says how large it is and where the media should go", () => {
    // The page that hit Cloudflare's memory limit: one 65 MB HTML file.
    const [warning, ...rest] = sitePageSizeWarnings(64_943_413);
    expect(rest).toEqual([]);
    expect(warning?.code).toBe("page_heavy");
    expect(warning?.message).toContain("62 MB");
    expect(warning?.suggestion).toContain("compress images");
    expect(warning?.suggestion).toContain("link video");
    // Site files are not for anonymous visitors: the advice says so.
    expect(warning?.suggestion).toContain("anonymous visitors can't read them");
    expect(sitePageSizeWarnings(SITE_PAGE_HEAVY_BYTES + 1)[0]?.message).toContain("5.0 MB");
  });

  test("a page the gateway won't serve says so", () => {
    const [warning] = sitePageSizeWarnings(SITE_PAGE_SERVED_MAX_BYTES + 1);
    expect(warning?.code).toBe("page_too_large");
    expect(warning?.message).toContain("256 MB");
    expect(warning?.message).toContain("Site too large");
    expect(sitePageSizeWarnings(SITE_PAGE_SERVED_MAX_BYTES)[0]?.code).toBe("page_heavy");
  });

  test("a publish result carries the warnings without losing its fields", () => {
    const result = { version: { sizeBytes: 9 * 1024 * 1024 }, replayed: true };
    const warned = withSitePageSizeWarnings(result);
    expect(warned.replayed).toBe(true);
    expect(warned.warnings?.map((warning) => warning.code)).toEqual(["page_heavy"]);
  });
});
