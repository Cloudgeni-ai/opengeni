import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register();

const { ARTIFACT_IFRAME_SANDBOX, ARTIFACT_SANDBOX_CSP, ArtifactSandbox, buildArtifactSrcDoc } =
  await import("./artifact-sandbox");

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("ArtifactSandbox", () => {
  it("places the platform CSP before untrusted source", () => {
    const source = '<main id="safe">Visible</main>';
    const document = buildArtifactSrcDoc(source);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(source));
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("script-src 'none'");
    expect(ARTIFACT_SANDBOX_CSP).not.toContain("unsafe-eval");
  });

  it("does not grant the opaque-origin iframe any sandbox capabilities", () => {
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-scripts");
  });

  it("keeps HTML and CSS while removing scripts and navigation-capable markup", () => {
    const document = buildArtifactSrcDoc(`
      <style>main { color: rebeccapurple; }</style>
      <meta http-equiv="refresh" content="0;url=https://example.com/leak">
      <script>location.href = "https://example.com/leak"</script>
      <form action="https://example.com/leak"><button>Send</button></form>
      <main onclick="location.href='https://example.com/leak'">Visible</main>
      <img src="https://example.com/tracker.png" alt="tracker">
    `);
    expect(document).toContain("main { color: rebeccapurple; }");
    expect(document).toContain("Visible");
    expect(document).not.toContain('http-equiv="refresh"');
    expect(document).not.toContain("<script");
    expect(document).not.toContain("<form");
    expect(document).not.toContain("onclick");
    expect(document).not.toContain("https://example.com");
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
