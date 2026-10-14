import { extname, join, normalize, sep } from "node:path";

/**
 * The app's own pages (first run, sign in) load from a private origin instead
 * of file://. The hardened build turns off file:// privileges, and a private
 * origin keeps these pages apart from every server the app talks to.
 */
export const LOCAL_SCHEME = "app";
export const LOCAL_ORIGIN = `${LOCAL_SCHEME}://local`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The file a local URL names inside `directory`, or null when it points elsewhere. */
export function localFile(directory: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (`${parsed.protocol}//${parsed.host}` !== LOCAL_ORIGIN) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const root = normalize(directory);
  const file = normalize(join(root, pathname));
  if (!file.startsWith(root + sep) || !(extname(file) in TYPES)) return null;
  return file;
}

/** The content type a local page file is served with. */
export function localContentType(file: string): string {
  return TYPES[extname(file)] ?? "application/octet-stream";
}

/** The local URL of a page in the served directory. */
export function localPageUrl(name: string): string {
  return `${LOCAL_ORIGIN}/${name}`;
}
