import path from "node:path";

const SETUP_ACCOUNT_BOOTSTRAP_START = '<script id="opengeni-setup-account-bootstrap">';
const REFERRER_META = '<meta name="referrer" content="no-referrer" />';

export function compactProtectedIndexHtml(
  html: string,
  options: { filename: string; canonicalFilename: string },
): string {
  if (path.resolve(options.filename) !== path.resolve(options.canonicalFilename)) return html;

  const scriptStart = html.indexOf(SETUP_ACCOUNT_BOOTSTRAP_START);
  if (scriptStart < 0) throw new Error("setup-account bootstrap is missing from index.html");
  const scriptEnd = html.indexOf("</script>", scriptStart);
  if (scriptEnd < 0) throw new Error("setup-account bootstrap is unterminated");
  const bootstrap = html.slice(scriptStart, scriptEnd + "</script>".length);
  const withoutBootstrap = `${html.slice(0, scriptStart)}${html.slice(scriptEnd + "</script>".length)}`;
  const referrerStart = withoutBootstrap.indexOf(REFERRER_META);
  if (referrerStart < 0)
    throw new Error("setup-account referrer policy is missing from index.html");
  const withoutProtectedHead = `${withoutBootstrap.slice(0, referrerStart)}${withoutBootstrap.slice(referrerStart + REFERRER_META.length)}`;
  return withoutProtectedHead
    .replace("<head>", `<head>${REFERRER_META}${bootstrap}`)
    .replace(/>\s+</g, "><")
    .trim();
}
