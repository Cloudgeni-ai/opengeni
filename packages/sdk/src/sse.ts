/**
 * Minimal incremental Server-Sent Events parser over a byte stream.
 *
 * Implements the parts of the SSE wire format OpenGeni uses: `id`, `event`,
 * and `data` fields, multi-line data, comment lines, and both LF and CRLF
 * line endings. Messages without any `data` (comments, id-only blocks) are
 * not emitted.
 */
export type SseMessage = {
  id?: string;
  event?: string;
  data: string;
};

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let dataLines: string[] | null = null;

  const dispatch = (): SseMessage | null => {
    const message =
      dataLines === null
        ? null
        : {
            ...(id !== undefined ? { id } : {}),
            ...(event !== undefined ? { event } : {}),
            data: dataLines.join("\n"),
          };
    id = undefined;
    event = undefined;
    dataLines = null;
    return message;
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line === "") {
      return dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      (dataLines ??= []).push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
    // Other fields (e.g. `retry`) are ignored; reconnect pacing is the
    // streaming layer's concern.
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        const message = handleLine(line);
        if (message) {
          yield message;
        }
        newline = buffer.indexOf("\n");
      }
    }
    // Per the SSE spec, a block is only dispatched on a blank line. Anything
    // still pending at end-of-stream came from a truncated connection and is
    // discarded — the streaming layer replays from its cursor on reconnect.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
