import { describe, expect, test } from "bun:test";
import { SITE_BRIDGE_BOOTSTRAP_SCRIPT } from "@opengeni/sdk/site-bridge-host";
import { SITE_BROWSER_RUNTIME } from "@opengeni/sdk/site-document";
import {
  SITE_CLIENT_TAG_MAX_CHARS,
  SITE_FRAME_HEAD_MAX_CHARS,
  SiteBootstrapInjector,
  SiteClientScriptResolver,
  SiteFrameTooLargeError,
  bootstrapPlaceKnown,
  byteLimit,
  lockstepTee,
  siteFrameStream,
  siteFrameTextTransform,
} from "../src/frame-stream";
import { siteFrameDocument } from "../src/version";

const CLIENT = '<script src="/__opengeni/site-tools/client.js"></script>';

/** Documents whose frame document the stream must reproduce exactly. */
const CASES: Record<string, string> = {
  empty: "",
  plain: "<p>Hello</p>",
  doctype: "<!doctype html><html><head><title>A</title></head><body>B</body></html>",
  upperDoctype: "<!DOCTYPE html>\n<html><body>x</body></html>",
  leadingSpace: " \n\t<!doctype html><p>x</p>",
  leadingComments: "<!-- a --> <!-- b -->\n<!doctype html><p>x</p>",
  unterminatedLeadingComment: "<!-- never closed <!doctype html><p>x</p>",
  doctypeWithoutEnd: "<!doctype html",
  notDoctype: "<!doc><p>x</p>",
  bomLike: "\uFEFF<!doctype html><p>x</p>",
  client: `<!doctype html><head>${CLIENT}</head><body>x</body>`,
  clientSingleQuotes: "<!doctype html><script src='/__opengeni/site-tools/client.js'></script>",
  clientSpaced: '<SCRIPT  src = "/__opengeni/site-tools/client.js" >\n \t</script >',
  clientTwice: `${CLIENT}<p>a</p>${CLIENT}`,
  clientInComment: `<!-- ${CLIENT} --><p>x</p>`,
  clientInScript: `<script>const tag = '${CLIENT.replace("</script>", "<\\/script>")}';</script>`,
  clientInScriptLiteral: `<script>document.write("${CLIENT.replace("</", "<\\/")}")</script>${CLIENT}`,
  clientWithBody: '<script src="/__opengeni/site-tools/client.js">x</script><p>y</p>',
  clientWithAttr: '<script defer src="/__opengeni/site-tools/client.js"></script>',
  clientMismatchedQuotes: `<script src="/__opengeni/site-tools/client.js'></script>`,
  clientCloseWithJunk: `<script src="/__opengeni/site-tools/client.js"></script x>${CLIENT}`,
  scriptBoundary: "<scripts>no</scripts><script-x>yes</script><script>z</script >",
  nestedScriptText: "<script>if (a < b && '<!--') {}</script><p>after</p>" + CLIENT,
  commentDashes: "<!----><!---><p>x</p>-->" + CLIENT,
  unicode: `<!doctype html><p>Opengeni — 日本語 😀</p>${CLIENT}<p>ß İ</p>`,
  longSpace: `<script src="/__opengeni/site-tools/client.js">${" ".repeat(100)}</script>`,
};

function frame(chunks: readonly string[]): string {
  const resolver = new SiteClientScriptResolver();
  const injector = new SiteBootstrapInjector();
  const out: string[] = [];
  const toInjector = (text: string) => injector.push(text, (piece) => out.push(piece));
  for (const chunk of chunks) resolver.push(chunk, toInjector);
  resolver.finish(toInjector);
  injector.finish((piece) => out.push(piece));
  return out.join("");
}

function splitAt(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts)]
    .filter((cut) => cut > 0 && cut < text.length)
    .sort((a, b) => a - b);
  const pieces: string[] = [];
  let last = 0;
  for (const point of points) {
    pieces.push(text.slice(last, point));
    last = point;
  }
  pieces.push(text.slice(last));
  return pieces;
}

/** Deterministic pseudo-random cut points. */
function* randomCuts(length: number, seed: number, count: number): Generator<number[]> {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  for (let round = 0; round < count; round += 1) {
    const cuts: number[] = [];
    const pieces = (next() % 6) + 1;
    for (let index = 0; index < pieces; index += 1) cuts.push(next() % (length + 1));
    yield cuts;
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("streamed frame document", () => {
  test("matches the whole-string document for every case, in one piece and split anywhere", () => {
    const failures: { name: string; chunks: string[] }[] = [];
    for (const [name, html] of Object.entries(CASES)) {
      const expected = siteFrameDocument(html);
      const check = (chunks: string[]) => {
        if (frame(chunks) !== expected) failures.push({ name, chunks });
      };
      check([html]);
      // One character at a time, every single cut, every pair of cuts, then random multi-cuts.
      check([...html]);
      for (let cut = 1; cut < html.length; cut += 1) check(splitAt(html, [cut]));
      // Pairs of cuts: all of them for short cases, an even sample for longer ones.
      const stride = Math.max(1, Math.ceil(html.length / 12));
      for (let first = 1; first < html.length; first += stride)
        for (let second = first + 1; second < html.length; second += 1)
          check(splitAt(html, [first, second]));
      for (const cuts of randomCuts(html.length, html.length + 7, 40)) check(splitAt(html, cuts));
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);

  test("resolves the client tag into the runtime and inserts the bootstrap after the doctype", () => {
    const out = frame([CASES.client!]);
    expect(out.startsWith(`<!doctype html>${SITE_BRIDGE_BOOTSTRAP_SCRIPT}`)).toBe(true);
    expect(out).not.toContain("/__opengeni/site-tools/client.js");
    expect(out).toContain(SITE_BROWSER_RUNTIME.slice(0, 200));
  });

  test("holds only a bounded amount of a large page, and emits as it goes", () => {
    const resolver = new SiteClientScriptResolver();
    const injector = new SiteBootstrapInjector();
    let emitted = 0;
    let pushed = 0;
    let maxHeld = 0;
    const toInjector = (text: string) =>
      injector.push(text, (piece) => {
        emitted += piece.length;
      });
    const filler = "<p>" + "x".repeat(60_000) + "</p>";
    const script = "<script>" + "var a = '<!-- not a comment';".repeat(2_000);
    const comment = "<!--" + "-".repeat(50_000);
    const parts = [
      "<!doctype html>",
      ...Array.from({ length: 50 }, () => filler),
      script,
      ...Array.from({ length: 10 }, () => filler),
      "</script>",
      comment,
      ...Array.from({ length: 10 }, () => filler),
      "-->",
      `<script src="/__opengeni/site-tools/client.js" data-x="${"y".repeat(SITE_CLIENT_TAG_MAX_CHARS)}">`,
      ...Array.from({ length: 10 }, () => filler),
      "</script>",
    ];
    for (const part of parts) {
      resolver.push(part, toInjector);
      pushed += part.length;
      maxHeld = Math.max(maxHeld, pushed - emitted + SITE_BRIDGE_BOOTSTRAP_SCRIPT.length);
    }
    resolver.finish(toInjector);
    injector.finish((piece) => {
      emitted += piece.length;
    });
    // Never more than one client-tag candidate plus a partial token is held back.
    expect(maxHeld).toBeLessThanOrEqual(
      SITE_CLIENT_TAG_MAX_CHARS * 2 + SITE_BRIDGE_BOOTSTRAP_SCRIPT.length,
    );
    expect(emitted).toBe(pushed + SITE_BRIDGE_BOOTSTRAP_SCRIPT.length);
  });

  test("the bootstrap's place is decided from a short head", () => {
    expect(bootstrapPlaceKnown("")).toBe(false);
    expect(bootstrapPlaceKnown("  ")).toBe(false);
    expect(bootstrapPlaceKnown("<!")).toBe(false);
    expect(bootstrapPlaceKnown("<!-- a")).toBe(false);
    expect(bootstrapPlaceKnown("<!-- a -->")).toBe(false);
    expect(bootstrapPlaceKnown("<!DOCTY")).toBe(false);
    expect(bootstrapPlaceKnown("<!doctype html")).toBe(false);
    expect(bootstrapPlaceKnown("<!doctype html>")).toBe(true);
    expect(bootstrapPlaceKnown("<html>")).toBe(true);
    expect(bootstrapPlaceKnown("<!-- a --><p>")).toBe(true);
    // A head with a never-ending comment is cut off and gets the bootstrap first.
    const injector = new SiteBootstrapInjector();
    const out: string[] = [];
    injector.push("<!--" + "a".repeat(SITE_FRAME_HEAD_MAX_CHARS), (piece) => out.push(piece));
    expect(out.join("").startsWith(SITE_BRIDGE_BOOTSTRAP_SCRIPT)).toBe(true);
  });

  test("streams bytes, including multi-byte characters split across chunks", async () => {
    const html = CASES.unicode!.repeat(50);
    const bytes = new TextEncoder().encode(html);
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += 7)
      chunks.push(bytes.slice(index, index + 7));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await readText(siteFrameStream(body))).toBe(siteFrameDocument(html));
  });

  test("the first bytes leave before the page has finished arriving", async () => {
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("<!doctype html><p>first</p>"));
        await released;
        controller.enqueue(encoder.encode("<p>last</p>"));
        controller.close();
      },
    });
    const reader = siteFrameStream(body).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("<p>first</p>");
    finish();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("<p>last</p>");
  });

  test("a page larger than the limit errors the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600).fill(0x61));
        controller.enqueue(new Uint8Array(600).fill(0x61));
        controller.close();
      },
    });
    await expect(readText(body.pipeThrough(byteLimit(1000)))).rejects.toBeInstanceOf(
      SiteFrameTooLargeError,
    );
  });

  test("the text transform is a TransformStream that keeps order", async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        for (const piece of [
          "<!doc",
          "type html><scr",
          'ipt src="/__opengeni/site-tools/client.js"></scr',
          "ipt><p>x</p>",
        ])
          controller.enqueue(piece);
        controller.close();
      },
    });
    let out = "";
    const reader = source.pipeThrough(siteFrameTextTransform()).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += value;
    }
    expect(out).toBe(
      siteFrameDocument(
        '<!doctype html><script src="/__opengeni/site-tools/client.js"></script><p>x</p>',
      ),
    );
  });
});

describe("lockstep tee", () => {
  function counted(total: number) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= total) {
            controller.close();
            return;
          }
          pulled += 1;
          controller.enqueue(new Uint8Array([pulled % 256]));
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, pulled: () => pulled };
  }

  test("a reader that falls behind holds the other back instead of buffering", async () => {
    const source = counted(1000);
    const { primary, secondary, done } = lockstepTee(source.stream);
    const fast = primary.getReader();
    // Only the primary branch reads: it must stall after a few chunks.
    const reads: ReturnType<typeof fast.read>[] = [];
    for (let index = 0; index < 20; index += 1) reads.push(fast.read());
    await Bun.sleep(20);
    expect(source.pulled()).toBeLessThanOrEqual(4);
    // Once the secondary reads too, both run to the end.
    const drainFast = (async () => {
      let count = (await Promise.all(reads)).filter((read) => !read.done).length;
      for (;;) {
        const read = await fast.read();
        if (read.done) return count;
        count += 1;
      }
    })();
    const [secondaryBytes, primaryCount] = await Promise.all([
      new Response(secondary).arrayBuffer(),
      drainFast,
    ]);
    await done;
    expect(secondaryBytes.byteLength).toBe(1000);
    expect(primaryCount).toBe(1000);
    expect(source.pulled()).toBe(1000);
  });

  test("releasing the secondary lets the primary finish without it", async () => {
    const source = counted(500);
    const tee = lockstepTee(source.stream);
    // The cache put settled without reading its body: nothing reads the secondary.
    setTimeout(tee.releaseSecondary, 10);
    expect((await new Response(tee.primary).arrayBuffer()).byteLength).toBe(500);
    await tee.done;
    tee.releaseSecondary();
  });

  test("releasing after the secondary was read to the end leaves both branches whole", async () => {
    const source = counted(300);
    const tee = lockstepTee(source.stream);
    const [a, b] = await Promise.all([
      new Response(tee.primary).arrayBuffer(),
      new Response(tee.secondary).arrayBuffer().finally(tee.releaseSecondary),
    ]);
    await tee.done;
    expect(a.byteLength).toBe(300);
    expect(b.byteLength).toBe(300);
  });

  test("both branches see every chunk in order", async () => {
    const source = counted(300);
    const { primary, secondary, done } = lockstepTee(source.stream);
    const [a, b] = await Promise.all([
      new Response(primary).arrayBuffer(),
      new Response(secondary).arrayBuffer(),
    ]);
    await done;
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    expect(a.byteLength).toBe(300);
  });

  test("a failed secondary does not stop the primary; a cancelled primary stops the source", async () => {
    const first = counted(100);
    const tee = lockstepTee(first.stream);
    await tee.secondary.cancel("cache refused");
    expect((await new Response(tee.primary).arrayBuffer()).byteLength).toBe(100);
    await tee.done;

    const second = counted(1_000_000);
    const cancelled = lockstepTee(second.stream);
    const reader = cancelled.primary.getReader();
    void new Response(cancelled.secondary).arrayBuffer().catch(() => undefined);
    await reader.read();
    await reader.cancel("viewer left");
    await cancelled.done;
    expect(second.pulled()).toBeLessThan(100);
  });
});
