import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositories = new Map<string, Promise<Map<string, string>>>();
/** Temporary bounded archives avoid GitHub REST limits. Retain metadata only. */
export function repositoryMetadata(repository: string, revision: string) {
  const key = repository + "/" + revision;
  let pending = repositories.get(key);
  if (!pending) {
    pending = load(repository, revision);
    repositories.set(key, pending);
  }
  return pending;
}
async function load(repository: string, revision: string) {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-plugin-metadata-"));
  try {
    const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${revision}`, {
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok || !response.body) throw Error(`Archive HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 32 * 1024 * 1024) throw Error("Archive exceeds 32 MiB");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const archive = join(directory, "source.tar.gz");
    await Bun.write(archive, new Blob(chunks));
    async function tar(args: string[]) {
      const process = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => process.kill(), 15000);
      try {
        const outputReader = process.stdout.getReader();
        const parts: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const part = await outputReader.read();
            if (part.done) break;
            total += part.value.length;
            if (total > 8 * 1024 * 1024) {
              process.kill();
              throw Error("Archive metadata exceeds limit");
            }
            parts.push(part.value);
          }
        } finally {
          await outputReader.cancel();
        }
        const output = await new Blob(parts).text();
        if ((await process.exited) !== 0) throw Error("Could not read plugin archive");
        if (output.length > 8 * 1024 * 1024) throw Error("Archive metadata exceeds limit");
        return output;
      } finally {
        clearTimeout(timer);
      }
    }
    const names = (await tar(["-tzf", archive])).split("\n").filter(Boolean);
    const result = new Map<string, string>();
    for (const name of names) {
      const path = name.split("/").slice(1).join("/");
      if (!path || path.split("/").some((part) => part === "..") || name.startsWith("/")) continue;
      // Record paths for component detection, but read only declarative manifests.
      result.set(path.replace(/\/$/, ""), "");
      if (
        /(^|\/)(\.mcp\.json|\.codex-plugin\/plugin\.json|\.claude-plugin\/plugin\.json)$/.test(path)
      ) {
        result.set(path, await tar(["-xOzf", archive, name]));
      }
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
