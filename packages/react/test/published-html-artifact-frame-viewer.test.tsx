import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PublishedHtmlArtifactFrame,
  siteFrameLocation,
} from "../src/components/artifacts/published-html-artifact-frame";

const html = "<!doctype html><main>Site</main>";

test("the frame keeps plain HTML unbridged without tools or a viewer", () => {
  const markup = renderToStaticMarkup(<PublishedHtmlArtifactFrame html={html} title="Site" />);
  expect(markup).not.toContain("opengeni.site.ready");
});

test("a viewer alone enables the bridge bootstrap", () => {
  const markup = renderToStaticMarkup(
    <PublishedHtmlArtifactFrame
      html={html}
      title="Site"
      viewer={{ kind: "member", id: "user:1", name: "Ada", email: null, signedIn: true }}
    />,
  );
  expect(markup).toContain("opengeni.site.ready");
  expect(markup).not.toContain("allow-same-origin");
});

test("a host-kept Site address becomes the Site's location; anything else is its root", () => {
  expect(siteFrameLocation("/unsubscribe?t=abc#done")).toEqual({
    path: "/unsubscribe",
    search: "?t=abc",
    hash: "#done",
  });
  const root = { path: "/", search: "", hash: "" };
  for (const other of [undefined, "", "https://example.com/x", "//example.com/x", "javascript:x"])
    expect(siteFrameLocation(other)).toEqual(root);
});
