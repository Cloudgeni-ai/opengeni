import { extname, resolve, sep } from "node:path";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";
const SHORT_CACHE_CONTROL = "public, max-age=3600";

export function createWebHandler(root = resolve(import.meta.dir, "../dist")) {
  const distRoot = resolve(root);
  const indexPath = resolve(distRoot, "index.html");

  return async function webHandler(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const requestedPath = safePath(distRoot, pathname);
    if (!requestedPath) {
      return new Response("Bad Request", { status: 400 });
    }

    const requestedFile = Bun.file(requestedPath);
    if (await requestedFile.exists()) {
      return serveFile(request, requestedPath, cacheControlFor(pathname));
    }
    if (pathname.startsWith("/assets/")) {
      return new Response("Not Found", { status: 404 });
    }
    return serveFile(request, indexPath, REVALIDATE_CACHE_CONTROL);
  };
}

function safePath(root: string, pathname: string): string | null {
  const candidate = resolve(root, `.${pathname}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE_CONTROL;
  if (extname(pathname) === ".html" || pathname === "/") return REVALIDATE_CACHE_CONTROL;
  return SHORT_CACHE_CONTROL;
}

async function serveFile(request: Request, path: string, cacheControl: string): Promise<Response> {
  const source = Bun.file(path);
  if (!(await source.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  const acceptsGzip =
    !request.headers.has("range") &&
    acceptsEncoding(request.headers.get("accept-encoding"), "gzip");
  const gzip = Bun.file(`${path}.gz`);
  const encoded = acceptsGzip && (await gzip.exists()) ? gzip : null;
  const body = encoded ?? source;
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": source.type || "application/octet-stream",
    vary: "Accept-Encoding",
  });
  if (encoded) headers.set("content-encoding", "gzip");
  if (request.method === "HEAD") {
    headers.set("content-length", String(body.size));
    return new Response(null, { headers });
  }
  return new Response(body, { headers });
}

function acceptsEncoding(header: string | null, encoding: string): boolean {
  if (!header) return false;
  for (const entry of header.split(",")) {
    const segments = entry.trim().split(";");
    const name = segments[0]?.toLowerCase();
    if (name !== encoding.toLowerCase() && name !== "*") continue;
    const parameters = segments.slice(1);
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return quality ? Number(quality.slice(2)) > 0 : true;
  }
  return false;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const hostname = process.env.HOST ?? DEFAULT_HOST;
  Bun.serve({ hostname, port, fetch: createWebHandler() });
  console.log(`OpenGeni web listening on http://${hostname}:${port}`);
}
