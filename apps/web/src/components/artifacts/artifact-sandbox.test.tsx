import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register();

const {
  ARTIFACT_IFRAME_SANDBOX,
  ARTIFACT_SANDBOX_CSP,
  ArtifactSandbox,
  buildArtifactDataUrl,
  buildArtifactSrcDoc,
} = await import("./artifact-sandbox");

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("ArtifactSandbox", () => {
  it("places the platform CSP before untrusted source", () => {
    const source = '<main id="safe">Visible</main>';
    const document = buildArtifactSrcDoc(source);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("Visible"));
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("script-src 'none'");
    expect(document).toContain("img-src 'none'");
    expect(document).toContain("font-src 'none'");
    expect(ARTIFACT_SANDBOX_CSP).not.toContain("unsafe-eval");
  });

  it("does not grant the opaque-origin iframe any sandbox capabilities", () => {
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-scripts");
  });

  it("uses an encoded data document so native fragment navigation stays in-frame", () => {
    const url = buildArtifactDataUrl(
      '<a id="jump" href="#artifact-section">Jump</a><p id="artifact-section">Target</p>',
    );
    expect(url).toStartWith("data:text/html;charset=utf-8,");
    expect(decodeURIComponent(url.split(",", 2)[1]!)).toContain('href="#artifact-section"');
  });

  it("preserves benign static HTML, CSS, native controls, and fragment targets", () => {
    const document = buildArtifactSrcDoc(`
      <style>
        :root { --accent: rebeccapurple; }
        main { display: grid; color: var(--accent); background: white; }
        #artifact-section:target { outline: 3px solid lime; }
      </style>
      <a id="jump" href="#artifact-section">Jump</a>
      <label><input id="check" type="checkbox" checked> Check</label>
      <details open><summary>More</summary><p>Native details</p></details>
      <main id="artifact-section" style="padding: 1rem; color: rebeccapurple">Visible</main>
    `);
    expect(document).toContain("display: grid");
    expect(document).toContain("color: var(--accent)");
    expect(document).toContain('href="#artifact-section"');
    expect(document).toContain('type="checkbox"');
    expect(document).toContain("<details open");
    expect(document).toContain(":target");
  });

  it("removes URL-bearing CSS declarations and disallowed at-rules without dropping safe rules", () => {
    const document = buildArtifactSrcDoc(`
      <style>
        @import "https://example.com/import.css";
        @font-face { font-family: leak; src: url(data:font/woff2;base64,AAAA); }
        main {
          color: rebeccapurple;
          display: grid;
          background-image: u\\72l(//example.com/background.png);
          cursor: image-set(url(blob:https://example.com/id) 1x), auto;
        }
        @media (min-width: 10px) {
          main { border-color: green; mask: url(#mask); }
        }
      </style>
      <main style="padding: 1rem; background: url(javascript:alert(1)); color: teal">Safe</main>
    `);
    expect(document).toContain("color: rebeccapurple");
    expect(document).toContain("display: grid");
    expect(document).toContain("border-color: green");
    expect(document).toContain("padding: 1rem");
    expect(document).toContain("color: teal");
    expect(document).not.toMatch(/url\s*\(/i);
    expect(document).not.toMatch(/@import|@font-face|https?:|data:|blob:|javascript:|\/\//i);
  });

  it("removes scripts, handlers, navigation, forms, external assets, and SVG URL references", () => {
    const document = buildArtifactSrcDoc(`
      <style>main { color: rebeccapurple; }</style>
      <meta http-equiv="refresh" content="0;url=https://example.com/leak">
      <script>location.href = "https://example.com/leak"</script>
      <form action="https://example.com/leak"><button>Send</button></form>
      <main onclick="location.href='https://example.com/leak'">Visible</main>
      <a id="external" href="//example.com" target="_blank" download>External</a>
      <a id="fragment" href="#visible">Fragment</a>
      <img src="data:image/svg+xml,bad" srcset="https://example.com/a 1x" alt="tracker">
      <picture><source src="blob:https://example.com/id" srcset="javascript:bad 1x"></picture>
      <svg><rect id="shape" fill="url(https://example.com/paint)" stroke="url(#stroke)"
        filter="url(data:image/svg+xml,bad)" mask="url(blob:https://example.com/id)"
        marker-start="url(//example.com/marker)" /></svg>
    `);
    expect(document).toContain("main { color: rebeccapurple }");
    expect(document).toContain("Visible");
    expect(document).toContain('href="#visible"');
    expect(document).not.toContain('http-equiv="refresh"');
    expect(document).not.toContain("<script");
    expect(document).not.toContain("<form");
    expect(document).not.toContain("onclick");
    expect(document).not.toMatch(/href="(?:\/\/|https?:|data:|blob:|javascript:)/i);
    expect(document).not.toMatch(/(?:src|srcset|filter|mask|marker-start|fill|stroke)="url\(/i);
    expect(document).not.toMatch(/https?:|data:|blob:|javascript:|\/\//i);
    expect(document).not.toContain('target="_blank"');
    expect(document).not.toContain("download");
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
