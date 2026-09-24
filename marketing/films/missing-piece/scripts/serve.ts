import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Static server for the film page. Returns the bound port. */
export function serveFilm(port = Number(process.env.PORT ?? 0)) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
      if (path.includes("..")) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(ROOT, path));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" },
      });
    },
  });
  return server;
}

if (import.meta.main) {
  const server = serveFilm(Number(process.env.PORT ?? 4700));
  console.log(`Preview: http://127.0.0.1:${server.port}/  (space = play, arrows = step)`);
}
