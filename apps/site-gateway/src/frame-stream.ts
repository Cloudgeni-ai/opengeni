/**
 * The Site frame document, streamed.
 *
 * `siteFrameDocument(html)` (version.ts) is the Site's HTML with its optional
 * client tag resolved (`resolveSiteClientScript`) and the bridge bootstrap
 * inserted after a leading doctype (`injectSiteBridgeBootstrap`). Building it
 * from one string holds several full copies of the page at once, which a large
 * Site (tens of megabytes of inlined media) turns into more than a Worker's
 * 128 MB and Cloudflare's raw "Error 1102". This module produces the same
 * document while the page streams through: it holds at most a few kilobytes
 * (a partial token, a candidate client tag, or the leading head before its
 * doctype), and hands those bounded pieces to the SDK functions so the
 * rewriting rules stay in one place.
 *
 * Differences from the whole-string functions, only for documents browsers
 * already treat as broken: an unterminated `<script>` or `<!--` leaves the rest
 * of the page untouched (a browser reads that rest as script text or comment),
 * and a doctype preceded by more than SITE_FRAME_HEAD_MAX_CHARS of leading
 * comments gets the bootstrap at the very start.
 */
import { injectSiteBridgeBootstrap } from "@opengeni/sdk/site-bridge-host";
import { resolveSiteClientScript } from "@opengeni/sdk/site-document";

/** Largest Site page the gateway serves (bytes from the API). Bounds the work per request. */
export const SITE_FRAME_MAX_BYTES = 256 * 1024 * 1024;
/** Most characters held to decide where the bootstrap goes (leading whitespace, comments, doctype). */
export const SITE_FRAME_HEAD_MAX_CHARS = 256 * 1024;
/**
 * Most characters held for a `<script>` element that may be the client tag
 * (its open tag plus a whitespace-only body). The real tag is about 60.
 */
export const SITE_CLIENT_TAG_MAX_CHARS = 4096;

/** Thrown into the stream when the page grows past SITE_FRAME_MAX_BYTES. */
export class SiteFrameTooLargeError extends Error {
  constructor() {
    super("Site page exceeds the gateway's size limit");
    this.name = "SiteFrameTooLargeError";
  }
}

type Emit = (text: string) => void;

// No `u` flag: the SDK's patterns are not Unicode-mode, and case folding must match theirs.
/** `<!--` or `<script` followed by a non-word character (the SDK's `<script\b`). */
const TOKEN = /<!--|<script(?![A-Za-z0-9_])/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const SCRIPT_CLOSE_AT = /<\/script\s*>/iy;
const SCRIPT_CLOSE_PARTIAL = /<\/script\s*$/i;
const NON_SPACE = /\S/g;

/** Start of a trailing partial match of any of `tokens` (lowercase), or `buffer.length`. */
function partialTail(buffer: string, from: number, tokens: readonly string[]): number {
  const longest = Math.max(...tokens.map((token) => token.length));
  for (let start = Math.max(from, buffer.length - longest + 1); start < buffer.length; start += 1) {
    const tail = buffer.slice(start).toLowerCase();
    if (tokens.some((token) => token.length > tail.length && token.startsWith(tail))) return start;
  }
  return buffer.length;
}

/**
 * Streaming `resolveSiteClientScript`: comments and script elements pass
 * through as they arrive; only a `<script>` whose open tag is short and whose
 * body is whitespace so far is held, and resolved by the SDK once it closes.
 */
export class SiteClientScriptResolver {
  private mode: "text" | "comment" | "open" | "open-pass" | "candidate" | "body" = "text";
  private carry = "";
  /** The held candidate element (`open`/`candidate`). */
  private element = "";

  push(chunk: string, emit: Emit): void {
    const buffer = this.carry + chunk;
    this.carry = "";
    let index = 0;
    while (index < buffer.length) {
      switch (this.mode) {
        case "text": {
          TOKEN.lastIndex = index;
          const match = TOKEN.exec(buffer);
          if (!match) {
            const hold = partialTail(buffer, index, ["<!--", "<script"]);
            if (hold > index) emit(buffer.slice(index, hold));
            this.carry = buffer.slice(hold);
            return;
          }
          const comment = match[0] === "<!--";
          // `<script` at the very end: the next character decides `\b`.
          if (!comment && match.index + match[0].length === buffer.length) {
            if (match.index > index) emit(buffer.slice(index, match.index));
            this.carry = buffer.slice(match.index);
            return;
          }
          if (match.index > index) emit(buffer.slice(index, match.index));
          index = match.index + match[0].length;
          if (comment) {
            emit(match[0]);
            this.mode = "comment";
          } else {
            this.element = match[0];
            this.mode = "open";
          }
          break;
        }
        case "comment": {
          const end = buffer.indexOf("-->", index);
          if (end < 0) {
            const hold = buffer.endsWith("--")
              ? buffer.length - 2
              : buffer.endsWith("-")
                ? buffer.length - 1
                : buffer.length;
            const keep = Math.max(hold, index);
            if (keep > index) emit(buffer.slice(index, keep));
            this.carry = buffer.slice(keep);
            return;
          }
          emit(buffer.slice(index, end + 3));
          index = end + 3;
          this.mode = "text";
          break;
        }
        case "open": {
          const end = buffer.indexOf(">", index);
          this.element += buffer.slice(index, end < 0 ? buffer.length : end + 1);
          index = end < 0 ? buffer.length : end + 1;
          if (this.element.length > SITE_CLIENT_TAG_MAX_CHARS) {
            emit(this.element);
            this.element = "";
            this.mode = end < 0 ? "open-pass" : "body";
          } else if (end >= 0) this.mode = "candidate";
          break;
        }
        case "open-pass": {
          const end = buffer.indexOf(">", index);
          const stop = end < 0 ? buffer.length : end + 1;
          emit(buffer.slice(index, stop));
          index = stop;
          if (end >= 0) this.mode = "body";
          break;
        }
        case "candidate": {
          NON_SPACE.lastIndex = index;
          const found = NON_SPACE.exec(buffer);
          const stop = found ? found.index : buffer.length;
          this.element += buffer.slice(index, stop);
          index = stop;
          if (this.element.length > SITE_CLIENT_TAG_MAX_CHARS) {
            emit(this.element);
            this.element = "";
            this.mode = "body";
            break;
          }
          if (!found) return;
          SCRIPT_CLOSE_AT.lastIndex = index;
          const close = SCRIPT_CLOSE_AT.exec(buffer);
          if (close) {
            emit(resolveSiteClientScript(this.element + close[0]));
            this.element = "";
            index += close[0].length;
            this.mode = "text";
            break;
          }
          // `</script` (and whitespace) may complete in the next chunk.
          const rest = buffer.slice(index);
          if (
            rest.length <= SITE_CLIENT_TAG_MAX_CHARS &&
            (SCRIPT_CLOSE_PARTIAL.exec(rest)?.index === 0 ||
              "</script".startsWith(rest.toLowerCase()))
          ) {
            this.carry = rest;
            return;
          }
          // Not the client tag: an ordinary script element from here on.
          emit(this.element);
          this.element = "";
          this.mode = "body";
          break;
        }
        case "body": {
          SCRIPT_CLOSE.lastIndex = index;
          const close = SCRIPT_CLOSE.exec(buffer);
          if (close) {
            const stop = close.index + close[0].length;
            emit(buffer.slice(index, stop));
            index = stop;
            this.mode = "text";
            break;
          }
          const hold = this.partialClose(buffer, index);
          if (hold > index) emit(buffer.slice(index, hold));
          this.carry = buffer.slice(hold);
          return;
        }
      }
    }
  }

  /** Start of a trailing `</script` (plus whitespace) that may close in the next chunk. */
  private partialClose(buffer: string, from: number): number {
    const windowStart = Math.max(from, buffer.length - SITE_CLIENT_TAG_MAX_CHARS);
    const open = SCRIPT_CLOSE_PARTIAL.exec(buffer.slice(windowStart));
    if (open) return windowStart + open.index;
    return partialTail(buffer, from, ["</script"]);
  }

  finish(emit: Emit): void {
    const rest = this.element + this.carry;
    this.element = "";
    this.carry = "";
    if (rest) emit(rest);
  }
}

/**
 * Whether the bootstrap's place is known from `head` alone: it mirrors the
 * SDK's leading-doctype scan (optional BOM, whitespace, comments, then
 * `<!doctype ...>`) and says "not yet" wherever that scan would read past the
 * end of `head`.
 */
export function bootstrapPlaceKnown(head: string): boolean {
  let cursor = head.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (cursor < head.length && /\s/.test(head[cursor]!)) cursor += 1;
    if (cursor >= head.length) return false;
    const rest = head.slice(cursor, cursor + 4);
    if (rest.length < 4 && "<!--".startsWith(rest)) return false;
    if (rest !== "<!--") break;
    const end = head.indexOf("-->", cursor + 4);
    if (end < 0) return false;
    cursor = end + 3;
  }
  const doctype = head.slice(cursor, cursor + 9).toLowerCase();
  if (doctype.length < 9) return !"<!doctype".startsWith(doctype);
  if (doctype !== "<!doctype") return true;
  return head.indexOf(">", cursor + 9) >= 0;
}

/** Streaming `injectSiteBridgeBootstrap`: holds only the leading head until the bootstrap's place is known. */
export class SiteBootstrapInjector {
  private head = "";
  private done = false;

  push(text: string, emit: Emit): void {
    if (this.done) {
      if (text) emit(text);
      return;
    }
    this.head += text;
    if (bootstrapPlaceKnown(this.head) || this.head.length > SITE_FRAME_HEAD_MAX_CHARS)
      this.flush(emit);
  }

  finish(emit: Emit): void {
    if (!this.done) this.flush(emit);
  }

  private flush(emit: Emit): void {
    emit(injectSiteBridgeBootstrap(this.head));
    this.head = "";
    this.done = true;
  }
}

/** Text in, frame document text out (client tag resolved, then the bootstrap inserted). */
export function siteFrameTextTransform(): TransformStream<string, string> {
  const resolver = new SiteClientScriptResolver();
  const injector = new SiteBootstrapInjector();
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const out: string[] = [];
      resolver.push(chunk, (text) => injector.push(text, (piece) => out.push(piece)));
      if (out.length) controller.enqueue(out.join(""));
    },
    flush(controller) {
      const out: string[] = [];
      const toInjector = (text: string) => injector.push(text, (piece) => out.push(piece));
      resolver.finish(toInjector);
      injector.finish((piece) => out.push(piece));
      if (out.length) controller.enqueue(out.join(""));
    },
  });
}

/** Bytes pass through until more than `limit` have; then the stream errors. */
export function byteLimit(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) controller.error(new SiteFrameTooLargeError());
      else controller.enqueue(chunk);
    },
  });
}

/**
 * The frame document for a Site page body, as UTF-8 bytes, without holding
 * the page in memory. Invalid UTF-8 decodes to U+FFFD, as `Response.text()`.
 */
export function siteFrameStream(
  body: ReadableStream<Uint8Array>,
  limit = SITE_FRAME_MAX_BYTES,
): ReadableStream<Uint8Array> {
  return body
    .pipeThrough(byteLimit(limit))
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .pipeThrough(siteFrameTextTransform())
    .pipeThrough(new TextEncoderStream() as unknown as TransformStream<string, Uint8Array>);
}

/**
 * Two readers of one stream that advance together: the next chunk is read
 * only once both branches have room, so a slow reader holds back the other
 * instead of the Worker buffering what one has read and the other has not
 * (which `ReadableStream.tee()` does). If the first (primary) branch is
 * cancelled or fails, both stop; if the second fails, the first carries on.
 * `done` settles when the source is finished or abandoned.
 */
export function lockstepTee(source: ReadableStream<Uint8Array>): {
  primary: ReadableStream<Uint8Array>;
  secondary: ReadableStream<Uint8Array>;
  done: Promise<void>;
} {
  const primary = new TransformStream<Uint8Array, Uint8Array>();
  const secondary = new TransformStream<Uint8Array, Uint8Array>();
  const primaryWriter = primary.writable.getWriter();
  const secondaryWriter = secondary.writable.getWriter();
  const reader = source.getReader();
  const done = (async () => {
    let secondaryOpen = true;
    const dropSecondary = (reason?: unknown) => {
      if (!secondaryOpen) return;
      secondaryOpen = false;
      secondaryWriter.abort(reason).catch(() => undefined);
    };
    try {
      for (;;) {
        await primaryWriter.ready;
        if (secondaryOpen) await secondaryWriter.ready.catch(dropSecondary);
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (secondaryOpen) secondaryWriter.write(value).catch(dropSecondary);
        primaryWriter.write(value).catch(() => undefined);
      }
      if (secondaryOpen) await secondaryWriter.close().catch(() => undefined);
      await primaryWriter.close();
    } catch (error) {
      dropSecondary(error);
      primaryWriter.abort(error).catch(() => undefined);
      await reader.cancel(error).catch(() => undefined);
    }
  })();
  return { primary: primary.readable, secondary: secondary.readable, done };
}
