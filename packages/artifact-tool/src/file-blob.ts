export class FileBlob extends Blob {
  readonly name: string | null;

  constructor(parts: BlobPart[], options: BlobPropertyBag & { name?: string | null } = {}) {
    super(parts, options);
    this.name = options.name ?? null;
  }

  static async load(path: string): Promise<FileBlob> {
    const fs = await loadNodeFileSystem();
    const bytes = await fs.readFile(path);
    return new FileBlob([bytes], { name: path });
  }

  static fromBytes(
    bytes: Uint8Array | ArrayBuffer,
    options: BlobPropertyBag & { name?: string | null } = {},
  ): FileBlob {
    return new FileBlob([bytes instanceof Uint8Array ? ownedBytes(bytes) : bytes], options);
  }

  async save(path: string): Promise<void> {
    const fs = await loadNodeFileSystem();
    await fs.writeFile(path, new Uint8Array(await this.arrayBuffer()));
  }
}

async function loadNodeFileSystem(): Promise<typeof import("node:fs/promises")> {
  // A literal dynamic import is still eagerly resolved by browser bundlers.
  // Keep this Node-only capability out of browser artifacts while retaining
  // ordinary native ESM resolution when load/save is actually called in Node.
  return importRuntimeModule<typeof import("node:fs/promises")>("node:fs/promises");
}

function importRuntimeModule<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
