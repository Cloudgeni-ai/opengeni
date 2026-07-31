import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ARTIFACT_IFRAME_SANDBOX,
  ARTIFACT_SANDBOX_CSP,
  ArtifactSandbox,
  buildArtifactSrcDoc,
} from "./artifact-sandbox";

describe("ArtifactSandbox", () => {
  it("places the platform CSP before untrusted source", () => {
    const source = '<script>document.body.textContent="ok"</script>';
    const document = buildArtifactSrcDoc(source);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(source));
    expect(document).toContain("connect-src 'none'");
    expect(ARTIFACT_SANDBOX_CSP).not.toContain("unsafe-eval");
  });

  it("uses an opaque-origin script-only sandbox policy", () => {
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("renders platform-owned stop, reload, focus, and version controls", () => {
    const markup = renderToStaticMarkup(
      <ArtifactSandbox html="<h1>Safe</h1>" title="Status" versionLabel="v4" />,
    );
    expect(markup).toContain('aria-label="Stop artifact"');
    expect(markup).toContain('aria-label="Reload artifact"');
    expect(markup).toContain('aria-label="Open focus mode"');
    expect(markup).toContain("v4");
  });
});
