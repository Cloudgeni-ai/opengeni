import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BrowserWorkspaceFileAuthority,
  BrowserWorkspaceFileStageRequest,
  BrowserWorkspaceFileStageResponse,
  type BrowserWorkspaceFileAuthority as BrowserWorkspaceFileAuthorityValue,
  type BrowserWorkspaceFileStageRequest as BrowserWorkspaceFileStageRequestValue,
  type BrowserWorkspaceFileStageResponse as BrowserWorkspaceFileStageResponseValue,
} from "@opengeni/contracts";
import { InteractionControllerError } from "@opengeni/interaction";

const MANIFEST_VERSION = 1;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 18 * 60_000;
const DOWNLOAD_CONCURRENCY = 4;
const MANIFEST_FILENAME = "manifest.json";
const MANIFEST_MAX_BYTES = 256 * 1024;
const StableWorkspaceFileSchema = BrowserWorkspaceFileAuthority.omit({ download: true });

type StableWorkspaceFile = Omit<BrowserWorkspaceFileAuthorityValue, "download">;

type StagingManifest = {
  version: typeof MANIFEST_VERSION;
  operationId: string;
  digest: string;
  files: StableWorkspaceFile[];
};

export type BrowserWorkspaceFileStagerOptions = {
  rootDirectory: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxTotalBytes?: number;
  downloadTimeoutMs?: number;
};

/** Placement-private, operation-scoped workspace-file materialization.
 * Durable metadata never contains the signed read authority; only verified
 * local bytes and their stable file envelope survive the staging request. */
export class BrowserWorkspaceFileStager {
  readonly rootDirectory: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly maxTotalBytes: number;
  private readonly downloadTimeoutMs: number;
  private tail: Promise<void> = Promise.resolve();

  private constructor(options: BrowserWorkspaceFileStagerOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxTotalBytes = boundedNonnegativeInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      "workspace-file staging byte limit",
    );
    this.downloadTimeoutMs = boundedTimeout(
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );
  }

  static async open(
    options: BrowserWorkspaceFileStagerOptions,
  ): Promise<BrowserWorkspaceFileStager> {
    const stager = new BrowserWorkspaceFileStager(options);
    await mkdir(stager.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(stager.rootDirectory, 0o700);
    return stager;
  }

  async stage(
    requestInput: BrowserWorkspaceFileStageRequestValue,
  ): Promise<BrowserWorkspaceFileStageResponseValue> {
    const request = BrowserWorkspaceFileStageRequest.parse(requestInput);
    const totalBytes = request.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxTotalBytes) {
      throw new InteractionControllerError(
        "invalid_action",
        "workspace files exceed the browser staging byte limit",
      );
    }
    let response: BrowserWorkspaceFileStageResponseValue | undefined;
    const operation = this.tail.then(async () => {
      response = await this.stageUnlocked(request);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    if (!response) throw new Error("workspace-file staging completed without a response");
    return response;
  }

  /** Resolve only bytes previously staged for this exact operation. A missing
   * or corrupted envelope returns no paths so the driver produces a definite
   * pre-side-effect resource_not_found receipt. */
  async resolve(operationId: string, workspaceFileIds: readonly string[]): Promise<string[]> {
    const parsedOperationId =
      BrowserWorkspaceFileStageResponse.shape.operationId.parse(operationId);
    const requested = workspaceFileIds.map((fileId) =>
      BrowserWorkspaceFileAuthority.shape.fileId.parse(fileId),
    );
    const manifest = await this.readManifest(parsedOperationId);
    if (!manifest) return [];
    const byId = new Map(manifest.files.map((file) => [file.fileId, file]));
    const paths: string[] = [];
    for (const fileId of requested) {
      const file = byId.get(fileId);
      if (!file) return [];
      const path = this.filePath(parsedOperationId, file);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size !== file.sizeBytes) return [];
      } catch {
        return [];
      }
      paths.push(path);
    }
    return paths;
  }

  async discard(operationId: string): Promise<void> {
    const parsedOperationId =
      BrowserWorkspaceFileStageResponse.shape.operationId.parse(operationId);
    const operation = this.tail.then(async () => {
      await rm(this.operationDirectory(parsedOperationId), { recursive: true, force: true });
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async stageUnlocked(
    request: BrowserWorkspaceFileStageRequestValue,
  ): Promise<BrowserWorkspaceFileStageResponseValue> {
    const stableFiles = request.files.map(stableWorkspaceFile);
    const digest = stableDigest(request.operationId, stableFiles);
    const existing = await this.readManifest(request.operationId);
    if (existing) {
      if (existing.digest !== digest) {
        throw new InteractionControllerError(
          "operation_conflict",
          "browser upload operation is already bound to different workspace files",
        );
      }
      const resolved = await this.resolve(
        request.operationId,
        request.files.map((file) => file.fileId),
      );
      if (resolved.length === request.files.length) {
        return BrowserWorkspaceFileStageResponse.parse({
          operationId: request.operationId,
          fileIds: request.files.map((file) => file.fileId),
          replayed: true,
        });
      }
    }
    this.assertAuthoritiesFresh(request.files);

    const operationDirectory = this.operationDirectory(request.operationId);
    await rm(operationDirectory, { recursive: true, force: true });
    const stagedBytes = await this.cleanOrphansAndMeasure();
    const requestedBytes = stableFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (stagedBytes + requestedBytes > this.maxTotalBytes) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser session workspace-file staging capacity is exhausted",
      );
    }
    await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
    try {
      const deadlineMs = Date.now() + this.downloadTimeoutMs;
      await mapWithConcurrency(request.files, DOWNLOAD_CONCURRENCY, async (file) => {
        const stable = stableWorkspaceFile(file);
        await this.downloadFile(this.filePath(request.operationId, stable), file, deadlineMs);
      });
      const manifest: StagingManifest = {
        version: MANIFEST_VERSION,
        operationId: request.operationId,
        digest,
        files: stableFiles,
      };
      const temporaryManifest = join(operationDirectory, `${MANIFEST_FILENAME}.partial`);
      await writeFile(temporaryManifest, JSON.stringify(manifest), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryManifest, join(operationDirectory, MANIFEST_FILENAME));
      return BrowserWorkspaceFileStageResponse.parse({
        operationId: request.operationId,
        fileIds: request.files.map((file) => file.fileId),
        replayed: false,
      });
    } catch (error) {
      await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof InteractionControllerError) throw error;
      throw new InteractionControllerError(
        "resource_unavailable",
        "workspace files could not be staged on the browser placement",
        true,
      );
    }
  }

  private async downloadFile(
    destination: string,
    file: BrowserWorkspaceFileAuthorityValue,
    deadlineMs: number,
  ): Promise<void> {
    const directory = resolve(destination, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.partial`;
    await rm(temporary, { force: true });
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs < 1_000) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "workspace-file staging deadline expired",
        true,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetch(file.download.url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new InteractionControllerError(
          "resource_unavailable",
          "workspace file download transport failed",
          true,
        );
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new InteractionControllerError(
          "resource_unavailable",
          `workspace file download returned HTTP ${response.status}`,
          true,
        );
      }
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== file.sizeBytes)
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new InteractionControllerError(
          "resource_unavailable",
          "workspace file download length does not match its authority",
          true,
        );
      }
      const verifier = new WorkspaceFileVerifier(file.sizeBytes, file.sha256);
      try {
        await pipeline(
          Readable.fromWeb(response.body as never),
          verifier,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        if (error instanceof InteractionControllerError) throw error;
        throw new InteractionControllerError(
          "resource_unavailable",
          "workspace file download stream failed",
          true,
        );
      }
      verifier.verify();
      await rename(temporary, destination);
      await chmod(destination, 0o400);
    } finally {
      clearTimeout(timer);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private assertAuthoritiesFresh(files: readonly BrowserWorkspaceFileAuthorityValue[]): void {
    const now = this.now().valueOf();
    if (files.some((file) => Date.parse(file.download.expiresAt) <= now)) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "workspace file download authority expired",
        true,
      );
    }
  }

  private async readManifest(operationId: string): Promise<StagingManifest | null> {
    let value: unknown;
    try {
      const path = join(this.operationDirectory(operationId), MANIFEST_FILENAME);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MANIFEST_MAX_BYTES) return null;
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return null;
      value = JSON.parse(text);
    } catch (error) {
      if (isMissingFile(error)) return null;
      return null;
    }
    const manifest = parseStagingManifest(value);
    return manifest?.operationId === operationId ? manifest : null;
  }

  private async cleanOrphansAndMeasure(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const operationId = BrowserWorkspaceFileStageResponse.shape.operationId.safeParse(entry.name);
      if (!operationId.success) {
        await rm(join(this.rootDirectory, entry.name), { recursive: true, force: true });
        continue;
      }
      const manifest = await this.readManifest(operationId.data);
      if (!manifest) {
        await rm(this.operationDirectory(operationId.data), { recursive: true, force: true });
        continue;
      }
      total += manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (!Number.isSafeInteger(total) || total > this.maxTotalBytes) return total;
    }
    return total;
  }

  private operationDirectory(operationId: string): string {
    return join(this.rootDirectory, operationId);
  }

  private filePath(operationId: string, file: StableWorkspaceFile): string {
    return join(this.operationDirectory(operationId), file.fileId, file.safeFilename);
  }
}

class WorkspaceFileVerifier extends Transform {
  private readonly hash = createHash("sha256");
  private bytes = 0;

  constructor(
    private readonly expectedBytes: number,
    private readonly expectedSha256: string | null,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += bytes.byteLength;
    if (this.bytes > this.expectedBytes) {
      callback(
        new InteractionControllerError(
          "resource_unavailable",
          "workspace file download exceeds its authorized size",
          true,
        ),
      );
      return;
    }
    this.hash.update(bytes);
    callback(null, bytes);
  }

  verify(): void {
    if (this.bytes !== this.expectedBytes) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "workspace file download was truncated",
        true,
      );
    }
    const digest = this.hash.digest("hex");
    if (this.expectedSha256 && digest !== this.expectedSha256) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "workspace file download checksum does not match its authority",
        true,
      );
    }
  }
}

function stableWorkspaceFile(file: BrowserWorkspaceFileAuthorityValue): StableWorkspaceFile {
  return {
    fileId: file.fileId,
    safeFilename: file.safeFilename,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  };
}

function stableDigest(operationId: string, files: readonly StableWorkspaceFile[]): string {
  return createHash("sha256").update(JSON.stringify({ operationId, files })).digest("hex");
}

function parseStagingManifest(value: unknown): StagingManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const operationId = BrowserWorkspaceFileStageResponse.shape.operationId.safeParse(
    record.operationId,
  );
  if (
    record.version !== MANIFEST_VERSION ||
    !operationId.success ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !Array.isArray(record.files) ||
    record.files.length < 1 ||
    record.files.length > 100
  ) {
    return null;
  }
  const parsedFiles: StableWorkspaceFile[] = [];
  for (const file of record.files) {
    const parsed = StableWorkspaceFileSchema.safeParse(file);
    if (!parsed.success) return null;
    parsedFiles.push(parsed.data);
  }
  if (new Set(parsedFiles.map((file) => file.fileId)).size !== parsedFiles.length) return null;
  if (stableDigest(operationId.data, parsedFiles) !== record.digest) return null;
  return {
    version: MANIFEST_VERSION,
    operationId: operationId.data,
    digest: record.digest,
    files: parsedFiles,
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

function boundedNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > DEFAULT_DOWNLOAD_TIMEOUT_MS) {
    throw new Error("workspace-file download timeout is invalid");
  }
  return value;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        await operation(values[index]!);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}
