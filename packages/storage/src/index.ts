import type { Settings } from "@opengeni/config";
import { RETAINED_OUTPUT_MAX_PAGE_BYTES, type FileAsset } from "@opengeni/contracts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  type BlobDownloadResponseParsed,
  type BlobGetPropertiesResponse,
} from "@azure/storage-blob";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  Storage as GcsClient,
  type GetSignedUrlConfig,
  type StorageOptions,
} from "@google-cloud/storage";

export * from "./bounded-object-read";
export * from "./bounded-object-write";
export * from "./object-storage-bounded";

export const MAX_SINGLE_PUT_SIZE_BYTES = 5_000_000_000;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
const INTERNAL_STREAM_BUFFER_BYTES = 1024 * 1024;
const INTERNAL_STREAM_CONCURRENCY = 2;

export type ObjectHead = {
  ContentLength?: number;
  ContentType?: string;
  Metadata?: Record<string, string>;
  /** Opaque provider generation/etag used only for conditional internal reads. */
  VersionToken?: string;
};

export type ObjectStorage = {
  bucket: string;
  backend: "s3-compatible" | "aws-s3" | "azure-blob" | "gcs";
  maxSinglePutSizeBytes: number;
  createPutUrl: (args: {
    key: string;
    contentType: string;
    sha256?: string | null;
    expiresInSeconds?: number;
  }) => Promise<{ url: string; requiredHeaders: Record<string, string>; expiresAt: Date }>;
  createGetUrl: (args: {
    key: string;
    expiresInSeconds?: number;
  }) => Promise<{ url: string; expiresAt: Date }>;
  headFile: (file: FileAsset) => Promise<ObjectHead>;
  /** Check provider existence without downloading object bytes. */
  fileExists: (file: FileAsset) => Promise<boolean>;
  getFileBytes: (file: FileAsset) => Promise<Uint8Array>;
  /**
   * Fetch exactly one inclusive byte range without materializing the complete
   * object. Returns null when the provider reports that the object is missing.
   */
  getFileRange: (
    file: FileAsset,
    range: { start: number; end: number },
  ) => Promise<Uint8Array | null>;
  /** Fetch an object by raw storage key (not a tracked FileAsset). Returns null on 404/missing. */
  getObjectBytes: (key: string) => Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  /** Provider-versioned raw-key primitives used by bounded immutable adapters. */
  headObject?: (key: string) => Promise<ObjectHead | null>;
  getObjectRange?: (args: {
    key: string;
    start: number;
    endInclusive: number;
    expectedVersionToken: string;
  }) => Promise<{ bytes: Uint8Array; versionToken: string } | null>;
  /**
   * SERVER-SIDE authenticated direct PUT (no presign + browser fetch). For an
   * in-process upload from a trusted holder of the storage credentials (e.g. the
   * worker writing a recording), this sends the bytes straight to the storage
   * backend over the configured endpoint with the in-process SDK client — bypassing
   * the presigned-URL round-trip, which on split public/internal topologies (a
   * public `objectStorageEndpoint` with no in-cluster route) would otherwise 401.
   * Browser uploads keep using `createPutUrl`; this is the trusted-server twin.
   * Repeating a PUT for the same deterministic key and verified sha256 is
   * permitted: storage backends converge to the same bytes, while the database
   * completion fence remains the source of truth.
   */
  putObject: (args: {
    key: string;
    contentType: string;
    body: Uint8Array;
    sha256?: string | null;
  }) => Promise<void>;
  /** Atomic create-only raw PUT. Returns false when the key already exists. */
  putObjectIfAbsent?: (args: {
    key: string;
    contentType: string;
    body: Uint8Array;
    sha256: string;
  }) => Promise<boolean>;
  /**
   * Atomic create-only raw upload from a bounded asynchronous byte stream.
   * Providers may buffer a small fixed number of chunks, never the whole body.
   */
  putObjectStreamIfAbsent?: (args: {
    key: string;
    contentType: string;
    chunks: AsyncIterable<Uint8Array>;
    byteSize: number;
    sha256: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  /**
   * SERVER-SIDE authenticated delete of a single object by raw storage key.
   * Idempotent: a missing key is a no-op (S3/GCS/Azure delete-by-key does not
   * 404 on absent objects, or the 404 is swallowed). Used by the Workbench v2
   * capture GC (keep the latest 10) to reap after-image blobs that no
   * surviving revision references. Best-effort at the call site — a failed
   * delete leaves an orphan blob, never corrupts a live capture.
   */
  deleteObject: (key: string) => Promise<void>;
};

export function createObjectStorage(settings: Settings): ObjectStorage | null {
  if (settings.objectStorageBackend === "azure-blob") {
    return createAzureBlobObjectStorage(settings);
  }
  if (settings.objectStorageBackend === "gcs") {
    return createGcsObjectStorage(settings);
  }
  return createS3CompatibleObjectStorage(settings);
}

function createS3CompatibleObjectStorage(settings: Settings): ObjectStorage | null {
  if (
    settings.objectStorageBackend === "s3-compatible" &&
    (!settings.objectStorageEndpoint ||
      !settings.objectStorageAccessKeyId ||
      !settings.objectStorageSecretAccessKey)
  ) {
    return null;
  }
  const sharedClientConfig: S3ClientConfig = {
    region: settings.objectStorageRegion,
    forcePathStyle: settings.objectStorageForcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    ...(settings.objectStorageAccessKeyId && settings.objectStorageSecretAccessKey
      ? {
          credentials: {
            accessKeyId: settings.objectStorageAccessKeyId,
            secretAccessKey: settings.objectStorageSecretAccessKey,
          },
        }
      : {}),
  };
  const presignClient = new S3Client({
    ...sharedClientConfig,
    ...(settings.objectStorageEndpoint ? { endpoint: settings.objectStorageEndpoint } : {}),
  });
  const requestClient = settings.objectStorageInternalEndpoint
    ? new S3Client({
        ...sharedClientConfig,
        endpoint: settings.objectStorageInternalEndpoint,
      })
    : presignClient;
  return {
    bucket: settings.objectStorageBucket,
    backend: settings.objectStorageBackend === "aws-s3" ? "aws-s3" : "s3-compatible",
    maxSinglePutSizeBytes: MAX_SINGLE_PUT_SIZE_BYTES,
    async createPutUrl(args) {
      const expiresIn = args.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
      const requiredHeaders: Record<string, string> = {
        "content-type": args.contentType,
      };
      const command = new PutObjectCommand({
        Bucket: settings.objectStorageBucket,
        Key: args.key,
        ContentType: args.contentType,
        Metadata: args.sha256 ? { sha256: args.sha256 } : undefined,
      });
      return {
        url: await getSignedUrl(presignClient, command, { expiresIn }),
        requiredHeaders,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    async createGetUrl(args) {
      const expiresIn = args.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
      return {
        url: await getSignedUrl(
          presignClient,
          new GetObjectCommand({
            Bucket: settings.objectStorageBucket,
            Key: args.key,
          }),
          { expiresIn },
        ),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    async putObject(args) {
      // Authenticated in-process PUT against the configured (in-cluster) endpoint.
      // A presigned URL buys nothing here — the worker already holds the creds — and
      // on a split public/internal endpoint topology the presigned URL points at the
      // PUBLIC host (no MinIO route → 401). This sends bytes straight to the backend.
      await requestClient.send(
        new PutObjectCommand({
          Bucket: settings.objectStorageBucket,
          Key: args.key,
          ContentType: args.contentType,
          Body: args.body,
          Metadata: args.sha256 ? { sha256: args.sha256 } : undefined,
        }),
      );
    },
    async putObjectIfAbsent(args) {
      try {
        await requestClient.send(
          new PutObjectCommand({
            Bucket: settings.objectStorageBucket,
            Key: args.key,
            ContentType: args.contentType,
            Body: args.body,
            Metadata: { sha256: args.sha256 },
            IfNoneMatch: "*",
          }),
        );
        return true;
      } catch (error) {
        if (isS3VersionMismatch(error)) return false;
        throw error;
      }
    },
    async putObjectStreamIfAbsent(args) {
      try {
        await requestClient.send(
          new PutObjectCommand({
            Bucket: settings.objectStorageBucket,
            Key: args.key,
            ContentType: args.contentType,
            ContentLength: args.byteSize,
            Body: Readable.from(args.chunks),
            Metadata: { sha256: args.sha256 },
            IfNoneMatch: "*",
          }),
          args.signal ? { abortSignal: args.signal } : undefined,
        );
        return true;
      } catch (error) {
        if (isS3VersionMismatch(error)) return false;
        throw error;
      }
    },
    async headFile(file) {
      const head = await requestClient.send(
        new HeadObjectCommand({
          Bucket: file.bucket,
          Key: file.objectKey,
        }),
      );
      return objectHead({
        contentLength: head.ContentLength,
        contentType: head.ContentType,
        metadata: head.Metadata,
      });
    },
    async fileExists(file) {
      try {
        await requestClient.send(
          new HeadObjectCommand({
            Bucket: file.bucket,
            Key: file.objectKey,
          }),
        );
        return true;
      } catch (error) {
        if (isS3NotFound(error)) return false;
        throw error;
      }
    },
    async getFileBytes(file) {
      const result = await requestClient.send(
        new GetObjectCommand({
          Bucket: file.bucket,
          Key: file.objectKey,
        }),
      );
      return await s3BodyToBytes(result.Body, file.objectKey);
    },
    async getFileRange(file, range) {
      const length = assertFileByteRange(file, range);
      try {
        const result = await requestClient.send(
          new GetObjectCommand({
            Bucket: file.bucket,
            Key: file.objectKey,
            Range: `bytes=${range.start}-${range.end}`,
          }),
        );
        return await s3BodyToBoundedBytes(result.Body, file.objectKey, length);
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
    async headObject(key) {
      try {
        const head = await requestClient.send(
          new HeadObjectCommand({ Bucket: settings.objectStorageBucket, Key: key }),
        );
        return objectHead({
          contentLength: head.ContentLength,
          contentType: head.ContentType,
          metadata: head.Metadata,
          versionToken: head.ETag,
        });
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
    async getObjectRange(args) {
      const length = assertRawObjectByteRange(args.key, args.start, args.endInclusive);
      try {
        const result = await requestClient.send(
          new GetObjectCommand({
            Bucket: settings.objectStorageBucket,
            Key: args.key,
            Range: `bytes=${args.start}-${args.endInclusive}`,
            IfMatch: args.expectedVersionToken,
          }),
        );
        if (!result.ETag || result.ETag !== args.expectedVersionToken) return null;
        return {
          bytes: await s3BodyToBoundedBytes(result.Body, args.key, length),
          versionToken: result.ETag,
        };
      } catch (error) {
        if (isS3NotFound(error) || isS3VersionMismatch(error)) return null;
        throw error;
      }
    },
    async getObjectBytes(key) {
      try {
        const result = await requestClient.send(
          new GetObjectCommand({
            Bucket: settings.objectStorageBucket,
            Key: key,
          }),
        );
        const bytes = await s3BodyToBytes(result.Body, key);
        return { bytes, ...(result.ContentType ? { contentType: result.ContentType } : {}) };
      } catch (error) {
        if (isS3NotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async deleteObject(key) {
      // S3 DeleteObject is idempotent — deleting an absent key returns 204.
      await requestClient.send(
        new DeleteObjectCommand({
          Bucket: settings.objectStorageBucket,
          Key: key,
        }),
      );
    },
  };
}

async function s3BodyToBytes(body: unknown, objectKey: string): Promise<Uint8Array> {
  if (!body) {
    throw new Error(`Object body is empty: ${objectKey}`);
  }
  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === "function") {
    return await withTransform.transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function s3BodyToBoundedBytes(
  body: unknown,
  objectKey: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!body) {
    throw new Error(`Object body is empty: ${objectKey}`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    const normalized = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += normalized.byteLength;
    if (bytes > expectedBytes) {
      throw new Error(`Object range exceeded requested length: ${objectKey}`);
    }
    chunks.push(normalized);
  }
  if (bytes !== expectedBytes) {
    throw new Error(
      `Object range length mismatch for ${objectKey}: expected ${expectedBytes}, received ${bytes}`,
    );
  }
  return Buffer.concat(chunks, bytes);
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  if (name === "NoSuchKey" || name === "NotFound") {
    return true;
  }
  const metadata =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      : undefined;
  return metadata?.httpStatusCode === 404;
}

function isS3VersionMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const metadata =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      : undefined;
  return metadata?.httpStatusCode === 412;
}

function createGcsObjectStorage(settings: Settings): ObjectStorage {
  const client = new GcsClient(gcsClientOptions(settings));
  const bucket = client.bucket(settings.objectStorageBucket);
  return {
    bucket: settings.objectStorageBucket,
    backend: "gcs",
    maxSinglePutSizeBytes: MAX_SINGLE_PUT_SIZE_BYTES,
    async createPutUrl(args) {
      const expiresIn = args.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const config: GetSignedUrlConfig = {
        version: "v4",
        action: "write",
        expires: expiresAt,
        contentType: args.contentType,
      };
      if (args.sha256) {
        config.extensionHeaders = { "x-goog-meta-sha256": args.sha256 };
      }
      const [url] = await bucket.file(args.key).getSignedUrl(config);
      return {
        url,
        requiredHeaders: {
          "content-type": args.contentType,
          ...(args.sha256 ? { "x-goog-meta-sha256": args.sha256 } : {}),
        },
        expiresAt,
      };
    },
    async createGetUrl(args) {
      const expiresIn = args.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const [url] = await bucket.file(args.key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt,
      });
      return { url, expiresAt };
    },
    async putObject(args) {
      // Authenticated in-process PUT via the GCS SDK (the server holds the creds).
      await bucket.file(args.key).save(Buffer.from(args.body), {
        contentType: args.contentType,
        ...(args.sha256 ? { metadata: { metadata: { sha256: args.sha256 } } } : {}),
      });
    },
    async putObjectIfAbsent(args) {
      try {
        await bucket.file(args.key).save(Buffer.from(args.body), {
          contentType: args.contentType,
          metadata: { metadata: { sha256: args.sha256 } },
          preconditionOpts: { ifGenerationMatch: 0 },
        });
        return true;
      } catch (error) {
        if (isGcsVersionMismatch(error)) return false;
        throw error;
      }
    },
    async putObjectStreamIfAbsent(args) {
      const destination = bucket.file(args.key).createWriteStream({
        resumable: false,
        contentType: args.contentType,
        highWaterMark: INTERNAL_STREAM_BUFFER_BYTES,
        metadata: { metadata: { sha256: args.sha256 } },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      try {
        if (args.signal) {
          await pipeline(Readable.from(args.chunks), destination, { signal: args.signal });
        } else {
          await pipeline(Readable.from(args.chunks), destination);
        }
        return true;
      } catch (error) {
        if (isGcsVersionMismatch(error)) return false;
        throw error;
      }
    },
    async headFile(file) {
      const [metadata] = await bucket.file(file.objectKey).getMetadata();
      return objectHead({
        contentLength: parseContentLength(metadata.size),
        contentType: metadata.contentType,
        metadata: stringMetadata(metadata.metadata),
      });
    },
    async fileExists(file) {
      try {
        await bucket.file(file.objectKey).getMetadata();
        return true;
      } catch (error) {
        if (isGcsNotFound(error)) return false;
        throw error;
      }
    },
    async getFileBytes(file) {
      const [bytes] = await bucket.file(file.objectKey).download();
      return bytes;
    },
    async getFileRange(file, range) {
      const length = assertFileByteRange(file, range);
      try {
        const [bytes] = await bucket
          .file(file.objectKey)
          .download({ start: range.start, end: range.end });
        return exactRangeBytes(bytes, file.objectKey, length);
      } catch (error) {
        if (isGcsNotFound(error)) return null;
        throw error;
      }
    },
    async headObject(key) {
      try {
        const [metadata] = await bucket.file(key).getMetadata();
        return objectHead({
          contentLength: parseContentLength(metadata.size),
          contentType: metadata.contentType,
          metadata: stringMetadata(metadata.metadata),
          versionToken: metadata.generation === undefined ? undefined : String(metadata.generation),
        });
      } catch (error) {
        if (isGcsNotFound(error)) return null;
        throw error;
      }
    },
    async getObjectRange(args) {
      const length = assertRawObjectByteRange(args.key, args.start, args.endInclusive);
      try {
        const [bytes] = await bucket
          .file(args.key, { generation: args.expectedVersionToken })
          .download({ start: args.start, end: args.endInclusive });
        return {
          bytes: exactRangeBytes(bytes, args.key, length),
          versionToken: args.expectedVersionToken,
        };
      } catch (error) {
        if (isGcsNotFound(error) || isGcsVersionMismatch(error)) return null;
        throw error;
      }
    },
    async getObjectBytes(key) {
      try {
        const [bytes] = await bucket.file(key).download();
        return { bytes };
      } catch (error) {
        if (isGcsNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async deleteObject(key) {
      // ignoreNotFound keeps the delete idempotent (a missing blob is a no-op).
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}

function isGcsNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === 404;
}

function isGcsVersionMismatch(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === 412;
}

function createAzureBlobObjectStorage(settings: Settings): ObjectStorage | null {
  const sharedKey = azureSharedKeyCredential(settings);
  const requestServiceClient = settings.objectStorageAzureConnectionString
    ? BlobServiceClient.fromConnectionString(settings.objectStorageAzureConnectionString)
    : new BlobServiceClient(azureBlobServiceUrl(settings), sharedKey);
  const presignServiceClient = settings.objectStorageAzureEndpoint
    ? new BlobServiceClient(azureBlobServiceUrl(settings), sharedKey)
    : requestServiceClient;
  const requestContainerClient = requestServiceClient.getContainerClient(
    settings.objectStorageBucket,
  );
  const presignContainerClient = presignServiceClient.getContainerClient(
    settings.objectStorageBucket,
  );

  return {
    bucket: settings.objectStorageBucket,
    backend: "azure-blob",
    maxSinglePutSizeBytes: MAX_SINGLE_PUT_SIZE_BYTES,
    async createPutUrl(args) {
      const expiresIn = args.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const blobClient = presignContainerClient.getBlockBlobClient(args.key);
      const sas = generateBlobSASQueryParameters(
        {
          containerName: settings.objectStorageBucket,
          blobName: args.key,
          permissions: BlobSASPermissions.parse("cw"),
          expiresOn: expiresAt,
          contentType: args.contentType,
        },
        sharedKey,
      ).toString();
      return {
        url: `${blobClient.url}?${sas}`,
        requiredHeaders: {
          "content-type": args.contentType,
          "x-ms-blob-type": "BlockBlob",
          ...(args.sha256 ? { "x-ms-meta-sha256": args.sha256 } : {}),
        },
        expiresAt,
      };
    },
    async createGetUrl(args) {
      const expiresIn = args.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const blobClient = presignContainerClient.getBlobClient(args.key);
      const sas = generateBlobSASQueryParameters(
        {
          containerName: settings.objectStorageBucket,
          blobName: args.key,
          permissions: BlobSASPermissions.parse("r"),
          expiresOn: expiresAt,
        },
        sharedKey,
      ).toString();
      return {
        url: `${blobClient.url}?${sas}`,
        expiresAt,
      };
    },
    async putObject(args) {
      // Authenticated in-process upload via the shared-key Azure client (no SAS).
      const blobClient = requestContainerClient.getBlockBlobClient(args.key);
      const body = Buffer.from(args.body);
      await blobClient.upload(body, body.byteLength, {
        blobHTTPHeaders: { blobContentType: args.contentType },
        ...(args.sha256 ? { metadata: { sha256: args.sha256 } } : {}),
      });
    },
    async putObjectIfAbsent(args) {
      const blobClient = requestContainerClient.getBlockBlobClient(args.key);
      const body = Buffer.from(args.body);
      try {
        await blobClient.upload(body, body.byteLength, {
          blobHTTPHeaders: { blobContentType: args.contentType },
          metadata: { sha256: args.sha256 },
          conditions: { ifNoneMatch: "*" },
        });
        return true;
      } catch (error) {
        if (isAzureVersionMismatch(error)) return false;
        throw error;
      }
    },
    async putObjectStreamIfAbsent(args) {
      const blobClient = requestContainerClient.getBlockBlobClient(args.key);
      try {
        await blobClient.uploadStream(
          Readable.from(args.chunks),
          INTERNAL_STREAM_BUFFER_BYTES,
          INTERNAL_STREAM_CONCURRENCY,
          {
            blobHTTPHeaders: { blobContentType: args.contentType },
            metadata: { sha256: args.sha256 },
            conditions: { ifNoneMatch: "*" },
            ...(args.signal ? { abortSignal: args.signal } : {}),
          },
        );
        return true;
      } catch (error) {
        if (isAzureVersionMismatch(error)) return false;
        throw error;
      }
    },
    async headFile(file) {
      return azureHeadToObjectHead(
        await requestContainerClient.getBlobClient(file.objectKey).getProperties(),
      );
    },
    async fileExists(file) {
      try {
        await requestContainerClient.getBlobClient(file.objectKey).getProperties();
        return true;
      } catch (error) {
        if (isAzureNotFound(error)) return false;
        throw error;
      }
    },
    async getFileBytes(file) {
      return await azureDownloadToBytes(
        await requestContainerClient.getBlobClient(file.objectKey).download(),
      );
    },
    async getFileRange(file, range) {
      const length = assertFileByteRange(file, range);
      try {
        return await azureDownloadToBoundedBytes(
          await requestContainerClient.getBlobClient(file.objectKey).download(range.start, length),
          file.objectKey,
          length,
        );
      } catch (error) {
        if (isAzureNotFound(error)) return null;
        throw error;
      }
    },
    async headObject(key) {
      try {
        const properties = await requestContainerClient.getBlobClient(key).getProperties();
        return objectHead({
          contentLength: properties.contentLength,
          contentType: properties.contentType,
          metadata: properties.metadata,
          versionToken: properties.etag,
        });
      } catch (error) {
        if (isAzureNotFound(error)) return null;
        throw error;
      }
    },
    async getObjectRange(args) {
      const length = assertRawObjectByteRange(args.key, args.start, args.endInclusive);
      try {
        const download = await requestContainerClient
          .getBlobClient(args.key)
          .download(args.start, length, { conditions: { ifMatch: args.expectedVersionToken } });
        if (!download.etag || download.etag !== args.expectedVersionToken) return null;
        return {
          bytes: await azureDownloadToBoundedBytes(download, args.key, length),
          versionToken: download.etag,
        };
      } catch (error) {
        if (isAzureNotFound(error) || isAzureVersionMismatch(error)) return null;
        throw error;
      }
    },
    async getObjectBytes(key) {
      try {
        const download = await requestContainerClient.getBlobClient(key).download();
        const bytes = await azureDownloadToBytes(download);
        return { bytes, ...(download.contentType ? { contentType: download.contentType } : {}) };
      } catch (error) {
        if (isAzureNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async deleteObject(key) {
      // deleteIfExists keeps the delete idempotent (a missing blob is a no-op).
      await requestContainerClient.getBlockBlobClient(key).deleteIfExists();
    },
  };
}

function isAzureNotFound(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function isAzureVersionMismatch(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { statusCode?: unknown }).statusCode === 412
  );
}

function azureSharedKeyCredential(settings: Settings): StorageSharedKeyCredential {
  if (settings.objectStorageAzureConnectionString) {
    const parsed = parseConnectionString(settings.objectStorageAzureConnectionString);
    if (parsed.AccountName && parsed.AccountKey) {
      return new StorageSharedKeyCredential(parsed.AccountName, parsed.AccountKey);
    }
    throw new Error(
      "Azure Blob connection string must include AccountName and AccountKey to create presigned URLs",
    );
  }
  if (!settings.objectStorageAzureAccountName || !settings.objectStorageAzureAccountKey) {
    throw new Error("Azure Blob storage requires account name and account key");
  }
  return new StorageSharedKeyCredential(
    settings.objectStorageAzureAccountName,
    settings.objectStorageAzureAccountKey,
  );
}

function azureBlobServiceUrl(settings: Settings): string {
  if (settings.objectStorageAzureEndpoint) {
    return settings.objectStorageAzureEndpoint.replace(/\/+$/, "");
  }
  if (!settings.objectStorageAzureAccountName) {
    throw new Error("Azure Blob storage requires account name");
  }
  return `https://${settings.objectStorageAzureAccountName}.blob.core.windows.net`;
}

function parseConnectionString(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      }),
  );
}

function gcsClientOptions(settings: Settings): StorageOptions {
  const options: StorageOptions = {
    ...(settings.objectStorageGcsProjectId
      ? { projectId: settings.objectStorageGcsProjectId }
      : {}),
    ...(settings.objectStorageGcsKeyFilename
      ? { keyFilename: settings.objectStorageGcsKeyFilename }
      : {}),
    ...(settings.objectStorageGcsApiEndpoint
      ? { apiEndpoint: settings.objectStorageGcsApiEndpoint }
      : {}),
  };
  if (settings.objectStorageGcsCredentialsJson) {
    options.credentials = parseGcsCredentials(settings.objectStorageGcsCredentialsJson);
  }
  return options;
}

function parseGcsCredentials(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GCS credentials JSON must be an object");
  }
  return parsed as Record<string, string>;
}

function parseContentLength(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringMetadata(
  value: Record<string, string | number | boolean | null> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function azureHeadToObjectHead(head: BlobGetPropertiesResponse): ObjectHead {
  return objectHead({
    contentLength: head.contentLength,
    contentType: head.contentType,
    metadata: head.metadata,
  });
}

async function azureDownloadToBytes(download: BlobDownloadResponseParsed): Promise<Uint8Array> {
  if (!download.readableStreamBody) {
    throw new Error("Azure Blob download response did not include a readable body");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of download.readableStreamBody as AsyncIterable<
    Uint8Array | Buffer | string
  >) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function azureDownloadToBoundedBytes(
  download: BlobDownloadResponseParsed,
  objectKey: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!download.readableStreamBody) {
    throw new Error("Azure Blob download response did not include a readable body");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of download.readableStreamBody as AsyncIterable<
    Uint8Array | Buffer | string
  >) {
    const normalized = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += normalized.byteLength;
    if (bytes > expectedBytes) {
      throw new Error(`Object range exceeded requested length: ${objectKey}`);
    }
    chunks.push(normalized);
  }
  if (bytes !== expectedBytes) {
    throw new Error(
      `Object range length mismatch for ${objectKey}: expected ${expectedBytes}, received ${bytes}`,
    );
  }
  return Buffer.concat(chunks, bytes);
}

function assertFileByteRange(
  file: Pick<FileAsset, "sizeBytes" | "objectKey">,
  range: { start: number; end: number },
): number {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end >= file.sizeBytes
  ) {
    throw new RangeError(`Invalid object byte range for ${file.objectKey}`);
  }
  const length = range.end - range.start + 1;
  if (length > RETAINED_OUTPUT_MAX_PAGE_BYTES) {
    throw new RangeError(
      `Object byte range exceeds ${RETAINED_OUTPUT_MAX_PAGE_BYTES} bytes for ${file.objectKey}`,
    );
  }
  return length;
}

function assertRawObjectByteRange(key: string, start: number, endInclusive: number): number {
  if (
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 2048 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start < 0 ||
    endInclusive < start
  ) {
    throw new RangeError("Invalid raw object byte range");
  }
  const length = endInclusive - start + 1;
  if (length > RETAINED_OUTPUT_MAX_PAGE_BYTES) {
    throw new RangeError("Raw object byte range exceeds the bounded page limit");
  }
  return length;
}

function exactRangeBytes(bytes: Uint8Array, objectKey: string, expectedBytes: number): Uint8Array {
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `Object range length mismatch for ${objectKey}: expected ${expectedBytes}, received ${bytes.byteLength}`,
    );
  }
  return bytes;
}

function objectHead(input: {
  contentLength?: number | undefined;
  contentType?: string | undefined;
  metadata?: Record<string, string> | undefined;
  versionToken?: string | undefined;
}): ObjectHead {
  return {
    ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
    ...(input.contentType !== undefined ? { ContentType: input.contentType } : {}),
    ...(input.metadata !== undefined ? { Metadata: input.metadata } : {}),
    ...(input.versionToken !== undefined ? { VersionToken: input.versionToken } : {}),
  };
}

export function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
