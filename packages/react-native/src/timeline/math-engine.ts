/* TeX to SVG for the native timeline, with MathJax's TeX font built in (no DOM, no
   network, no WebView). `markdown-math.tsx` requires this module the first time a
   message has math, so apps whose chats never show math never evaluate it. */
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";

/** A typeset formula: an SVG document plus its size and baseline in ex. */
export type TypesetMath = {
  svg: string;
  /** Width and height in ex units of the surrounding font. */
  width: number;
  height: number;
  /** How far the formula reaches below the text baseline, in ex. */
  depth: number;
};

export type MathEngine = (tex: string, display: boolean) => TypesetMath | null;

class TexError extends Error {}

export function createMathEngine(): MathEngine {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    InputJax: new TeX({
      packages: ["base", "ams", "boldsymbol", "newcommand"],
      // Bad TeX falls back to its source in the message rather than red error text.
      formatError: (_jax: unknown, error: { message: string }) => {
        throw new TexError(error.message);
      },
    }),
    // Paths inline in each formula: no shared <defs>/<use> for the SVG renderer to resolve.
    OutputJax: new SVG({ fontCache: "none" }),
  });
  const cache = new Map<string, TypesetMath | null>();
  return (tex, display) => {
    const key = `${display ? "D" : "I"}${tex}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let result: TypesetMath | null = null;
    try {
      const container = document.convert(tex, { display });
      const svg = adaptor.firstChild(container) as Parameters<typeof adaptor.getAttribute>[0];
      const width = parseFloat(adaptor.getAttribute(svg, "width") ?? "");
      const height = parseFloat(adaptor.getAttribute(svg, "height") ?? "");
      const align = /vertical-align:\s*(-?[\d.]+)ex/.exec(adaptor.getAttribute(svg, "style") ?? "");
      // The view sets the size in points; ex sizes and CSS on the root do not apply natively.
      for (const attribute of ["width", "height", "style", "role", "focusable"]) {
        adaptor.removeAttribute(svg, attribute);
      }
      if (Number.isFinite(width) && Number.isFinite(height)) {
        result = {
          svg: adaptor.outerHTML(svg),
          width,
          height,
          depth: align ? -parseFloat(align[1]!) : 0,
        };
      }
    } catch {
      result = null;
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, result);
    return result;
  };
}
