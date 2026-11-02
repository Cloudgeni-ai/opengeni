/**
 * A Worker for test/frame-stream.miniflare.test.ts: rewrites a page fetched
 * from the test's origin with the gateway's `siteFrameStream`, in workerd,
 * and records how many pieces the rewrite produced.
 */
import { siteFrameStream } from "../../src/frame-stream";

let last: { pieces: number; bytes: number } | null = null;

export default {
  async fetch(request: Request, env: { ORIGIN: string }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/stats") return Response.json(last);
    last = null;
    const upstream = await fetch(`${env.ORIGIN}/page${url.search}`);
    let pieces = 0;
    let bytes = 0;
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pieces += 1;
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        last = { pieces, bytes };
      },
    });
    return new Response(siteFrameStream(upstream.body!).pipeThrough(counted));
  },
};
