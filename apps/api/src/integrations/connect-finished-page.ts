import { createHash } from "node:crypto";
import type { ConnectResultPageText } from "@opengeni/config";

/**
 * Where a sign-in popup ends (`finishInPopup` on a Connect attempt): a small
 * page that closes the window, instead of the host page's URL loading a
 * second copy of the whole product inside the popup. It never claims an
 * outcome; the app that started it follows the attempt and shows whether it worked.
 */
export const CONNECT_FINISHED_PATH = "/v1/integrations/connect/finished";

const CLOSE_SCRIPT = "window.close();";
const CLOSE_SCRIPT_HASH = createHash("sha256").update(CLOSE_SCRIPT).digest("base64");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * One of the API's own small result pages, in the deployment's words
 * (`OPENGENI_CONNECT_RESULT_PAGE_TEXT_JSON`). Static: it never echoes
 * anything from the request.
 */
export function connectResultPage(input: {
  text: ConnectResultPageText;
  title: string;
  lines: readonly string[];
  status?: number;
  closeWindow?: boolean;
}): Response {
  const lang = escapeHtml(input.text.lang ?? "en");
  const title = escapeHtml(input.title);
  const lines = input.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const script = input.closeWindow ? `<script>${CLOSE_SCRIPT}</script>` : "";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="color-scheme" content="light dark"><style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5;color:#1f2328;background:#fff;text-align:center}h1{font-size:1.3rem;margin:0 0 .5rem}p{margin:0 0 .5rem;color:#59636e}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}p{color:#9198a1}}</style></head><body><h1>${title}</h1>${lines}${script}</body></html>`;
  return new Response(html, {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; ${input.closeWindow ? `script-src 'sha256-${CLOSE_SCRIPT_HASH}'; ` : ""}frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}

export function connectFinishedPage(text: ConnectResultPageText = {}): Response {
  return connectResultPage({
    text,
    title: text.signInFinishedTitle ?? "You can close this window",
    lines: [text.signInFinishedBody ?? "Go back to where you started to continue."],
    closeWindow: true,
  });
}
