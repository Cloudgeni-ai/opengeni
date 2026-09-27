/** Blob URLs belong to the old browser process; Chrome error documents are not
 * navigation destinations. Keep a visible tab explaining the loss instead of
 * aborting restoration of every other tab and the durable profile. */
export function restoredTabUrl(url: string): string {
  const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
  if (scheme !== "blob:" && scheme !== "chrome-error:") return url;

  const original = url.slice(0, 1_024).replace(/[&<>"']/gu, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!;
  });
  const reason =
    scheme === "blob:"
      ? "This temporary preview belonged to the previous browser process. Return to its original page to create the preview again."
      : "This tab contained a browser error page. Return to the page you were trying to open and try again.";
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>Tab could not be restored</title><h1>Tab could not be restored</h1><p>${reason}</p><p>Your other tabs and saved browser profile remain available.</p><pre>${original}${url.length > 1_024 ? " [URL shortened]" : ""}</pre>`;
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`;
}
