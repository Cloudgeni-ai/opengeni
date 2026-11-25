import { expect, test } from "bun:test";
import { SITE_CHARTS_JS } from "@opengeni/sdk/site-ui";
import { siteUiAsset } from "../src/site-ui-asset";

test("serves the chart helpers as a cross-origin, nosniff script for GET and HEAD only", async () => {
  const url = "https://app.example/__opengeni/charts.js";
  const type = "text/javascript; charset=utf-8";
  const get = siteUiAsset(new Request(url), true, type, SITE_CHARTS_JS);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe(type);
  expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  expect(get.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(get.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await get.text()).toContain("window.og");
  const head = siteUiAsset(new Request(url, { method: "HEAD" }), true, type, SITE_CHARTS_JS);
  expect(await head.text()).toBe("");
  const post = siteUiAsset(new Request(url, { method: "POST" }), true, type, SITE_CHARTS_JS);
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
});
