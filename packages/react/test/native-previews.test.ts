import { describe, expect, test } from "bun:test";
import {
  interactivePreviewKind,
  paintPreviewLoading,
  parseSiteFence,
  PREVIEW_LOADING_PAINT_SCRIPT,
  previewLoadingDocument,
} from "../src/native-previews";

/** A 2D context that records every call and property write, in order. */
function recordingContext() {
  const calls: unknown[] = [];
  const gradient = { addColorStop: (...args: unknown[]) => calls.push(["stop", ...args]) };
  const target: Record<string, unknown> = {};
  const context = new Proxy(target, {
    get: (_target, key) =>
      key === "createRadialGradient"
        ? (...args: unknown[]) => {
            calls.push(["gradient", ...args]);
            return gradient;
          }
        : (...args: unknown[]) => calls.push([String(key), ...args]),
    set: (_target, key, value) => {
      calls.push(["set", String(key), value === gradient ? "gradient" : value]);
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

describe("native previews", () => {
  test("the embedded paint script draws exactly what the web canvas draws", () => {
    const script = new Function(
      `${PREVIEW_LOADING_PAINT_SCRIPT}; return paintPreviewLoading;`,
    )() as (...args: Parameters<typeof paintPreviewLoading>) => void;
    for (const [w, h, t] of [
      [320, 260, 2],
      [411, 360, 7.25],
    ] as const) {
      const web = recordingContext();
      const native = recordingContext();
      paintPreviewLoading(web.context, w, h, t, "#9fdccd", "#5fb8a3");
      script(native.context, w, h, t, "#9fdccd", "#5fb8a3");
      expect(native.calls.length).toBeGreaterThan(100);
      expect(native.calls).toEqual(web.calls);
    }
  });

  test("the loading document escapes its label and honours reduced motion", () => {
    const page = previewLoadingDocument({
      scheme: "light",
      label: "<b>Lager</b>",
      reducedMotion: true,
    });
    expect(page).toContain("&lt;b&gt;Lager&lt;/b&gt;");
    expect(page).toContain("const still=true");
    expect(page).toContain("#f9f9f9");
    expect(previewLoadingDocument({ scheme: "dark" })).toContain("Preparing preview…");
  });

  test("recognizes preview fences and validates Site references", () => {
    expect(interactivePreviewKind("opengeni-html")).toBe("html");
    expect(interactivePreviewKind("opengeni-site")).toBe("site");
    expect(interactivePreviewKind("html")).toBeNull();
    const siteId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(parseSiteFence(JSON.stringify({ siteId }))).toEqual({ siteId });
    expect(parseSiteFence(JSON.stringify({ siteId, versionId: siteId }))).toEqual({
      siteId,
      versionId: siteId,
    });
    expect(parseSiteFence(JSON.stringify({ siteId: "nope" }))).toBeNull();
    expect(parseSiteFence("{")).toBeNull();
  });
});
