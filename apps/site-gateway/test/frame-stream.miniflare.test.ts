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
/** A BOM, invalid bytes, an encoded surrogate and a truncated last character. */
const BROKEN_BYTES = new Uint8Array([
  0xef,
  0xbb,
  0xbf,
  ...new TextEncoder().encode("<!doctype html><p>a"),
  0xff,
  0xc3,
  0x41,
  0xed,
  0xa0,
  0x80,
  ...new TextEncoder().encode("😀 ß</p>"),
  0xf0,
  0x9f,
  0x98,
]);

let server: ReturnType<typeof Bun.serve> | null = null;
let mf: Miniflare | null = null;
/** Set when the origin's endless page is cancelled (the viewer went away). */
let endlessCancelled = false;
const stalls: (() => void)[] = [];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Waits up to 10 seconds for `check` to hold, and says whether it did. */
async function eventually(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await sleep(20);
  return check();
}

function inPieces(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function origin(request: Request): Response {
  const url = new URL(request.url);
  const headers = { "content-type": "text/html" };
  const encoder = new TextEncoder();
  switch (url.pathname) {
    case "/broken": {
      const piece = Number(url.searchParams.get("piece") ?? "0");
      return new Response(piece ? inPieces(BROKEN_BYTES, piece) : BROKEN_BYTES, { headers });
    }
    case "/stall": {
      // A doctype split across two writes, then nothing until the test ends.
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("<!do"));
            await sleep(100);
            controller.enqueue(encoder.encode("ctype html><p>first</p>"));
            await new Promise<void>((release) => stalls.push(release));
            controller.close();
          },
        }),
        { headers },
      );
    }
    case "/endless": {
      const piece = encoder.encode(`<p>${"x".repeat(1000)}</p>`);
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await sleep(1);
            controller.enqueue(piece);
          },
          cancel() {
            endlessCancelled = true;
          },
        }),
        { headers },
      );
    }
    case "/error": {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await sleep(5);
            if (sent++ < 3) return controller.enqueue(encoder.encode("<!doctype html><p>x</p>"));
            controller.error(new Error("origin failed"));
          },
        }),
        { headers },
      );
    }
    default: {
      const piece = Number(url.searchParams.get("piece") ?? "0");
      return new Response(piece ? inPieces(PAGE_BYTES, piece) : PAGE_BYTES, { headers });
    }
  }
}

beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: origin });
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
  for (const release of stalls) release();
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

  for (const [name, search] of [
    ["whole", ""],
    ["in 1 byte pieces", "?piece=1"],
  ] as const) {
    test(`a BOM, invalid UTF-8 and a truncated ending decode like Response.text(), sent ${name}`, async () => {
      const response = await mf!.dispatchFetch(
        `http://frame.test/collect?src=${encodeURIComponent(`/broken${search}`)}`,
      );
      expect(await response.json()).toEqual({
        text: siteFrameDocument(new TextDecoder().decode(BROKEN_BYTES)),
      });
    }, 30_000);
  }

  test("a doctype split across writes still starts the page before the origin finishes", async () => {
    const response = await mf!.dispatchFetch("http://frame.test/first?src=/stall");
    const outcome = (await response.json()) as { first?: string; timedOut?: boolean };
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.first).toContain("<p>first</p>");
  }, 30_000);

  test("a viewer going away cancels the page at the origin", async () => {
    endlessCancelled = false;
    const response = await mf!.dispatchFetch("http://frame.test/first?src=/endless&cancel=1");
    expect(((await response.json()) as { first?: string }).first).toContain("<p>xxx");
    expect(await eventually(() => endlessCancelled)).toBe(true);
  }, 30_000);

  test("an origin failure mid-page errors the rewrite", async () => {
    const response = await mf!.dispatchFetch("http://frame.test/collect?src=/error");
    const outcome = (await response.json()) as { text?: string; error?: string };
    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toBeString();
  }, 30_000);
});
