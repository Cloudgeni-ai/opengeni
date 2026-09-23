import { SITE_BROWSER_RUNTIME } from "./site-browser-runtime.gen";

export const SITE_CLIENT_SCRIPT_PATH = "/__opengeni/site-tools/client.js";
export { SITE_BROWSER_RUNTIME };

/** Resolve only the optional client tag; ordinary bundled Sites remain unchanged. */
export function resolveSiteClientScript(html: string): string {
  // Consume whole scripts/comments so examples inside JS or comments stay literal.
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
    if (
      !/^<script\s+src\s*=\s*(["'])\/__opengeni\/site-tools\/client\.js\1\s*>\s*<\/script\s*>$/i.test(
        tag,
      )
    )
      return tag;
    return "<script>" + SITE_BROWSER_RUNTIME.replace(/<\/script/gi, "<\\/script") + "</script>";
  });
}
