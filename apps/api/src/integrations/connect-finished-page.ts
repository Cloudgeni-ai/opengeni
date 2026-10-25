import { createHash } from "node:crypto";

/**
 * Where a sign-in popup ends (`finishInPopup` on a Connect attempt): a small
 * page that closes the window, instead of the host page's URL loading a
 * second copy of the whole product inside the popup. It never claims an
 * outcome; the chat follows the attempt itself and shows whether it worked.
 */
export const CONNECT_FINISHED_PATH = "/v1/integrations/connect/finished";

const CLOSE_SCRIPT = "window.close();";
const CLOSE_SCRIPT_HASH = createHash("sha256").update(CLOSE_SCRIPT).digest("base64");

export function connectFinishedPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You can close this window</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5;color:#1f2328;text-align:center}h1{font-size:1.3rem;margin:0 0 .5rem}p{margin:0;color:#59636e}</style></head><body><h1>You can close this window</h1><p>Go back to your chat to continue.</p><script>${CLOSE_SCRIPT}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${CLOSE_SCRIPT_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}
