/**
 * A Worker for test/frame-stream.miniflare.test.ts: rewrites a page fetched
 * from the test's origin with the gateway's `siteFrameStream`, in workerd,
 * and records how many pieces the rewrite produced.
 *
 * - `/rewrite?…`: streams the rewrite of the origin's `/page?…` and records
 *   its pieces for `/stats`;
 * - `/stream?src=/path`: streams the rewrite of the origin's `/path`;
 * - `/collect?src=/path`: reads the whole rewrite inside the Worker and
 *   answers `{ text }` or `{ error }`;
 * - `/first?src=/path`: answers the rewrite's first piece as `{ first }`, or
 *   `{ timedOut: true }` if none left within 5 seconds (measured inside the
 *   Worker: a response streamed back through Miniflare arrives in batches);
 *   `&cancel=1` cancels the rewrite after its first piece either way.
 */
import { siteFrameStream } from "../../src/frame-stream";

let last: { pieces: number; bytes: number } | null = null;

export default {
  async fetch(request: Request, env: { ORIGIN: string }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/stats") return Response.json(last);
    if (url.pathname === "/first") {
      const upstream = await fetch(`${env.ORIGIN}${url.searchParams.get("src")}`);
      const reader = siteFrameStream(upstream.body!).getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 5_000);
        }),
      ]);
      clearTimeout(timer);
      if (url.searchParams.get("cancel")) await reader.cancel("viewer left").catch(() => undefined);
      else reader.releaseLock();
      if (!first) return Response.json({ timedOut: true });
      return Response.json({ first: new TextDecoder().decode(first.value) });
    }
    if (url.pathname === "/stream" || url.pathname === "/collect") {
      const upstream = await fetch(`${env.ORIGIN}${url.searchParams.get("src")}`);
      const document = siteFrameStream(upstream.body!);
      if (url.pathname === "/stream") return new Response(document);
      try {
        return Response.json({ text: await new Response(document).text() });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
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
