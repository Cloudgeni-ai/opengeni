import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Disposable, bounded cache. Missing/corrupt files cause fresh verification. */
export class DiskCache {
  private entries: Record<string, { at: number; value: unknown }> | null = null;
  constructor(
    readonly path: string,
    readonly limit = 4096,
  ) {}
  private async load() {
    if (this.entries) return this.entries;
    try {
      const text = await readFile(this.path, "utf8");
      if (text.length > 16_000_000) throw new Error("cache too large");
      const data = JSON.parse(text);
      if (data.version !== 1 || !data.entries || Array.isArray(data.entries))
        throw new Error("invalid cache");
      this.entries = data.entries;
    } catch {
      this.entries = {};
    }
    return this.entries!;
  }
  async get<T>(key: string, maxAgeMs = Infinity): Promise<T | null> {
    const entry = (await this.load())[key];
    return entry && Number.isFinite(entry.at) && Date.now() - entry.at <= maxAgeMs
      ? (entry.value as T)
      : null;
  }
  async set(key: string, value: unknown): Promise<void> {
    const entries = await this.load();
    entries[key] = { at: Date.now(), value };
    const ordered = Object.keys(entries).sort((a, b) => entries[a]!.at - entries[b]!.at);
    for (const old of ordered.slice(0, Math.max(0, ordered.length - this.limit)))
      delete entries[old];
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
