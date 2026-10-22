import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishedHtmlArtifactFrame } from "../src/components/artifacts/published-html-artifact-frame";

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
