import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress, createZstdDecompress } from "node:zlib";
import type { WorkspaceArchiveSpool } from "./workspace-archive-spool";

/**
 * Stream JSON lines through zstd into a private file, metering the compressed
 * bytes. The session archive writes its bundle and transcript this way, and
 * the secret history scrub rewrites them the same way.
 */
export async function writeCompressedJsonLines(
  path: string,
  produce: (write: (line: string) => Promise<void>) => Promise<void>,
): Promise<WorkspaceArchiveSpool> {
  const zstd = createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 9 } });
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      callback(null, chunk);
    },
  });
  const piping = pipeline(zstd, meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  const write = async (line: string) => {
    if (!zstd.write(`${line}\n`)) await once(zstd, "drain");
  };
  try {
    await produce(write);
    zstd.end();
    await piping;
  } catch (error) {
    zstd.destroy(error instanceof Error ? error : new Error(String(error)));
    await piping.catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  }
  return {
    path,
    byteSize,
    sha256: hash.digest("hex"),
    open: () => createReadStream(path),
    dispose: async () => rm(path, { force: true }),
  };
}

/** Read the lines of a zstd-compressed JSON lines file, without the newlines. */
export async function* readCompressedJsonLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path).pipe(createZstdDecompress());
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}
