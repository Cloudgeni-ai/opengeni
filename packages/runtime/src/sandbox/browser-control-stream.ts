export const CONTROLLER_STREAM_MAX_INPUT = 128 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

/** One command over the existing binary-input transport. The command is static
 * with a stable trailer so replayed command output remains readable; all
 * authority and page data stay on stdin.
 * Base64 preserves screenshot bytes across text-only command result adapters. */
export function controllerStreamRequest(input: {
  method: string;
  url: string;
  token: string;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}): { cmd: string; stdin: Uint8Array; marker: string } {
  const quote = (value: string): string => {
    if (/[\r\n\0]/u.test(value)) throw new Error("invalid controller request value");
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  };
  const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  const marker = "OPENGENI_CONTROLLER_END_V1";
  const config = [
    "silent",
    "show-error",
    "include",
    `noproxy = "*"`,
    `connect-timeout = ${Math.min(seconds, 15)}`,
    `max-time = ${seconds}`,
    `max-filesize = ${input.maxBytes}`,
    `request = ${quote(input.method)}`,
    `url = ${quote(input.url)}`,
    `header = ${quote(`Authorization: Bearer ${input.token}`)}`,
    ...(input.body === undefined
      ? []
      : [`header = "Content-Type: application/json"`, `data-binary = ${quote(input.body)}`]),
    "",
  ].join("\n");
  const stdin = Buffer.from(config);
  if (stdin.byteLength > CONTROLLER_STREAM_MAX_INPUT) {
    throw new RangeError("controller command input is too large");
  }
  return {
    cmd: `(curl --disable --config -; controller_exit=$?; printf '\\n${marker}%s' "$controller_exit") | base64`,
    stdin,
    marker,
  };
}

export function parseControllerStreamResponse(
  output: string,
  marker: string,
  maxBytes: number,
): { status: number; headers: Map<string, string>; data: Uint8Array } {
  const maxWireBytes = maxBytes + MAX_HEADER_BYTES + marker.length + 32;
  // Allow the standard base64 utility's line wrapping, but no arbitrary log
  // noise or oversized allocation before validating and decoding the payload.
  if (output.length > Math.ceil(maxWireBytes / 3) * 4 * 1.05 + 4) {
    throw new RangeError("controller response exceeds its byte bound");
  }
  const encoded = output.replace(/[\r\n]/gu, "");
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error("controller response encoding is invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  const trailer = Buffer.from(`\n${marker}`);
  const end = bytes.lastIndexOf(trailer);
  if (end < 0) throw new Error("controller response is incomplete");
  const exit = bytes.subarray(end + trailer.length).toString("ascii");
  if (!/^\d{1,3}$/u.test(exit) || exit !== "0") {
    throw new Error("controller request did not complete successfully");
  }
  let offset = 0;
  while (offset < end) {
    const headerEnd = bytes.indexOf("\r\n\r\n", offset);
    if (headerEnd < offset || headerEnd + 4 > end || headerEnd + 4 > MAX_HEADER_BYTES) {
      throw new Error("controller response headers are invalid");
    }
    const lines = bytes.subarray(offset, headerEnd).toString("latin1").split("\r\n");
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/u.exec(lines.shift() ?? "");
    if (!match) throw new Error("controller response status is invalid");
    const status = Number(match[1]);
    offset = headerEnd + 4;
    if (status >= 100 && status < 200 && status !== 101) continue;
    if (status < 200 || status > 599) throw new Error("controller response status is invalid");
    const headers = new Map<string, string>();
    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("controller response header is invalid");
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const data = bytes.subarray(offset, end);
    if (data.byteLength > maxBytes)
      throw new RangeError("controller response exceeds its byte bound");
    return { status, headers, data };
  }
  throw new Error("controller response is incomplete");
}
