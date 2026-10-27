import { readFile } from "node:fs/promises";
import { parseToolArguments } from "./tool-arguments";

export type ToolArgumentInput = {
  readFile?: (path: string) => Promise<Uint8Array>;
  readStdin?: () => Promise<Uint8Array>;
};

/**
 * Read `ogtool call` arguments from inline JSON, `@path` (a local file,
 * relative to the working directory) or `-` (stdin through EOF), the same
 * forms the native `codemode call` accepts. A file or stdin keeps large
 * arguments out of argv, whose single-argument limit inline JSON can exceed.
 * Errors never echo the input.
 */
export async function readToolArguments(
  source: string | undefined,
  input: ToolArgumentInput = {},
): Promise<Record<string, unknown>> {
  if (source === "-") {
    const bytes = await (input.readStdin ?? readStandardInput)();
    return parseToolArguments(
      decodeUtf8(bytes, "tool arguments could not be read as UTF-8 from stdin"),
    );
  }
  if (source?.startsWith("@")) {
    const path = source.slice(1);
    if (!path) throw new Error("tool arguments file path is required after @");
    let bytes: Uint8Array;
    try {
      bytes = await (input.readFile ?? readFile)(path);
    } catch {
      throw new Error("tool arguments file could not be read as UTF-8");
    }
    return parseToolArguments(decodeUtf8(bytes, "tool arguments file could not be read as UTF-8"));
  }
  return parseToolArguments(source);
}

async function readStandardInput(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(message);
  }
}
