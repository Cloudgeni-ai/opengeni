import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

const exit = z.object({ exit_code: z.number().int() });

/** Decode the native Worker HTTP protocol, not the SDK's formatted Output.
 * A tee of the one original response owns full stream custody through EOF.
 * The SDK's missing-exit fallback is deliberately not terminal proof. */
export async function collectCloudflareCommandOutput(response: Response): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
} | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const text = new TextDecoder("utf-8", { fatal: true });
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const output = { stdout: "", stderr: "" };
  let exitCode: number | undefined;
  let buffer = "";
  const event = (frame: string) => {
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r\n|\n|\r/u)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "event") type = value;
      if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    const value = data.join("\n");
    if (type === "stdout" || type === "stderr") {
      const encoded = value.replace(/\s+/gu, "");
      const bytes = Buffer.from(atob(encoded), "latin1");
      if (bytes.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, ""))
        throw new Error("Invalid native output bytes");
      output[type] += decoders[type].write(bytes);
    } else if (type === "exit") {
      const parsed = exit.parse(JSON.parse(value));
      if (exitCode !== undefined || !Number.isSafeInteger(parsed.exit_code))
        throw new Error("Invalid native terminal receipt");
      exitCode = parsed.exit_code;
    } else {
      throw new Error("Unproven native output event");
    }
  };
  const drain = () => {
    const delimiter = /\r\n\r\n|\n\n|\r\r/gu;
    let start = 0;
    for (const match of buffer.matchAll(delimiter)) {
      event(buffer.slice(start, match.index));
      start = match.index + match[0].length;
    }
    buffer = buffer.slice(start);
  };
  try {
    while (true) {
      const page = await reader.read();
      if (page.done) break;
      buffer += text.decode(page.value, { stream: true });
      drain();
    }
    buffer += text.decode();
    drain();
    // Undispatched/truncated frames cannot be silently accepted as EOF.
    if (buffer.trim() || exitCode === undefined) return null;
    output.stdout += decoders.stdout.end();
    output.stderr += decoders.stderr.end();
    return { ...output, exitCode };
  } catch {
    return null;
  } finally {
    // A failed tee must not retain an unread response branch indefinitely.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
