/**
 * What counts as model progress on an SSE model response stream.
 *
 * Bytes alone do not prove that a generation is advancing: a provider can keep
 * a connection alive with SSE comments, `ping`/`keepalive` events or repeated
 * `response.in_progress` status frames while the generation behind it is
 * wedged. Every transport that bounds a stalled stream by model progress uses
 * this one classifier, so they agree on which frames are only keepalive.
 */

const KEEPALIVE_EVENT_TYPE =
  /^(?:keepalive|keep_alive|keep-alive|ping|heartbeat|response\.in_progress|response\.queued)$/i;
const MAX_PENDING_LINE_CHARS = 64 * 1024;

/** Keepalive and status-only event types that carry no model progress. */
export function isKeepaliveStreamEventType(type: string): boolean {
  return KEEPALIVE_EVENT_TYPE.test(type);
}

/**
 * Incremental SSE classifier: does this chunk complete at least one
 * model-progress `data:` line? SSE comments, `event:` lines, and keepalive
 * event types are not progress. Unknown JSON shapes (e.g. chat completion
 * chunks without a top-level `type`) are progress.
 */
export class SseProgressScanner {
  private readonly decoder = new TextDecoder();
  private pending = "";

  push(chunk: Uint8Array): boolean {
    // Linear in the chunk: split once and keep only the incomplete tail. A
    // "\r\n" split across chunks yields one extra empty (non-progress) line.
    const lines = (this.pending + this.decoder.decode(chunk, { stream: true })).split(/\r\n|\r|\n/);
    this.pending = lines.pop() ?? "";
    let progress = false;
    for (const line of lines) {
      if (isProgressLine(line)) {
        progress = true;
        break;
      }
    }
    if (this.pending.length > MAX_PENDING_LINE_CHARS) {
      // A very long single data line (large output item) is itself progress.
      if (this.pending.startsWith("data:")) progress = true;
      this.pending = this.pending.startsWith("data:") ? "data:" : "";
    }
    return progress;
  }
}

function isProgressLine(line: string): boolean {
  if (!line.startsWith("data:")) return false;
  const data = line.slice(5).trim();
  if (data.length === 0) return false;
  if (data === "[DONE]") return true;
  const type = /^\{\s*"type"\s*:\s*"([^"\\]{1,128})"/.exec(data)?.[1];
  return type === undefined || !isKeepaliveStreamEventType(type);
}
