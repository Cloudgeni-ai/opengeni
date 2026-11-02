/**
 * Integration: the Site frame rewrite in workerd (Miniflare), on a page shaped
 * like a real heavy Site: tens of megabytes of media inlined as base64 in one
 * `<script>`. workerd hands a fetched body to JavaScript in 4 KB pieces, and
 * every piece the rewrite handles costs fixed CPU; read that way, a 65 MB
 * page cost the deployed gateway 4 to 9 seconds of its 10 second CPU limit.
 * The rewrite must read in large pieces however the origin sends the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { SITE_FRAME_MIN_READ_BYTES } from "../src/frame-stream";
import { siteFrameDocument } from "../src/version";

const CLIENT_TAG = '<script src="/__opengeni/site-tools/client.js"></script>';
/** About 32 MB: a doctype, the client tag, one big media script, then multi-byte text. */
const PAGE = [
  `<!doctype html><html><head><title>Landing</title>${CLIENT_TAG}</head><body>`,
  '<script>(()=>{const media={"/landing/app.webp":{"type":"image/webp","bytes":"',
  "UklGRnL9AABXRUJQVlA4IGb9AAAQpgSdASqAB7AEPmEwlUgkIqIhIVJI0IAMCWlu/FIs".repeat(450_000),
  '"}};window.media=media;})();</script>',
  "<p>Opengeni — 日本語 😀 ß İ</p>\n".repeat(30_000),
  '<script type="module">document.body.dataset.ready="1"</script><p>The end</p></body></html>',
].join("");
const PAGE_BYTES = new TextEncoder().encode(PAGE);
const EXPECTED = siteFrameDocument(PAGE);

let server: ReturnType<typeof Bun.serve> | null = null;
let mf: Miniflare | null = null;

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const piece = Number(new URL(request.url).searchParams.get("piece") ?? "0");
      if (!piece) return new Response(PAGE_BYTES, { headers: { "content-type": "text/html" } });
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= PAGE_BYTES.length) return controller.close();
            controller.enqueue(PAGE_BYTES.slice(offset, offset + piece));
            offset += piece;
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const buildDir = mkdtempSync(join(tmpdir(), "site-gateway-frame-test-"));
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "fixtures/frame-stream-worker.ts")],
      outdir: buildDir,
      target: "browser",
      format: "esm",
      naming: "worker.js",
    });
    if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
    mf = new Miniflare({
      modules: true,
      scriptPath: join(buildDir, "worker.js"),
      modulesRoot: buildDir,
      compatibilityDate: "2026-07-01",
      bindings: { ORIGIN: `http://127.0.0.1:${server.port}` },
    });
    await mf.ready;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  server?.stop(true);
});

async function rewrite(search: string): Promise<{ body: string; pieces: number; bytes: number }> {
  const response = await mf!.dispatchFetch(`http://frame.test/rewrite${search}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  const stats = (await (await mf!.dispatchFetch("http://frame.test/stats")).json()) as {
    pieces: number;
    bytes: number;
  };
  return { body, ...stats };
}

describe("Site frame rewrite in workerd", () => {
  for (const [name, search] of [
    ["sent whole", ""],
    ["sent in 1 KB pieces", "?piece=1024"],
  ] as const) {
    test(`a 32 MB page ${name} is rewritten exactly, in large reads`, async () => {
      const { body, pieces, bytes } = await rewrite(search);
      expect(body.length).toBe(EXPECTED.length);
      expect(body === EXPECTED).toBe(true);
      expect(bytes).toBeGreaterThan(PAGE_BYTES.length);
      // One piece per read: the first returns as soon as anything arrives,
      // every later one waits for SITE_FRAME_MIN_READ_BYTES or the end. Read
      // in workerd's default 4 KB pieces this would be about 8,000.
      expect(pieces).toBeLessThanOrEqual(
        Math.ceil(PAGE_BYTES.length / SITE_FRAME_MIN_READ_BYTES) + 2,
      );
    }, 60_000);
  }
});
