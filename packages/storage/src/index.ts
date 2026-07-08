import type { Settings } from "@opengeni/config";
import type { FileAsset } from "@opengeni/contracts";
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

export const MAX_SINGLE_PUT_SIZE_BYTES = 5_000_000_000;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export type ObjectHead = {
  ContentLength?: number;
  ContentType?: string;
  Metadata?: Record<string, string>;
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
  getFileBytes: (file: FileAsset) => Promise<Uint8Array>;
  /** Fetch an object by raw storage key (not a tracked FileAsset). Returns null on 404/missing. */
  getObjectBytes: (key: string) => Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  /**
   * SERVER-SIDE authenticated direct PUT (no presign + browser fetch). For an
   * in-process upload from a trusted holder of the storage credentials (e.g. the
   * worker writing a recording), this sends the bytes straight to the storage
   * backend over the configured endpoint with the in-process SDK client — bypassing
   * the presigned-URL round-trip, which on split public/internal topologies (a
   * public `objectStorageEndpoint` with no in-cluster route) would otherwise 401.
   * Browser uploads keep using `createPutUrl`; this is the trusted-server twin.
   */
  putObject: (args: {
    key: string;
    contentType: string;
    body: Uint8Array;
    sha256?: string | null;
  }) => Promise<void>;
  /**
   * SERVER-SIDE authenticated delete of a single object by raw storage key.
   * Idempotent: a missing key is a no-op (S3/GCS/Azure delete-by-key does not
   * 404 on absent objects, or the 404 is swallowed). Used by the Workbench v2
   * capture GC (dossier §10.1 keep-latest-10) to reap after-image blobs that no
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
  const clientConfig: S3ClientConfig = {
    region: settings.objectStorageRegion,
    forcePathStyle: settings.objectStorageForcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    ...(settings.objectStorageEndpoint ? { endpoint: settings.objectStorageEndpoint } : {}),
    ...(settings.objectStorageAccessKeyId && settings.objectStorageSecretAccessKey
      ? {
          credentials: {
            accessKeyId: settings.objectStorageAccessKeyId,
            secretAccessKey: settings.objectStorageSecretAccessKey,
          },
        }
      : {}),
  };
  const client = new S3Client(clientConfig);
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
        url: await getSignedUrl(client, command, { expiresIn }),
        requiredHeaders,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    async createGetUrl(args) {
      const expiresIn = args.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
      return {
        url: await getSignedUrl(
          client,
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
      await client.send(
        new PutObjectCommand({
          Bucket: settings.objectStorageBucket,
          Key: args.key,
          ContentType: args.contentType,
          Body: args.body,
          Metadata: args.sha256 ? { sha256: args.sha256 } : undefined,
        }),
      );
    },
    async headFile(file) {
      const head = await client.send(
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
    async getFileBytes(file) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: file.bucket,
          Key: file.objectKey,
        }),
      );
      return await s3BodyToBytes(result.Body, file.objectKey);
    },
    async getObjectBytes(key) {
      try {
        const result = await client.send(
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
      await client.send(
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
    async headFile(file) {
      const [metadata] = await bucket.file(file.objectKey).getMetadata();
      return objectHead({
        contentLength: parseContentLength(metadata.size),
        contentType: metadata.contentType,
        metadata: stringMetadata(metadata.metadata),
      });
    },
    async getFileBytes(file) {
      const [bytes] = await bucket.file(file.objectKey).download();
      return bytes;
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

function createAzureBlobObjectStorage(settings: Settings): ObjectStorage | null {
  const sharedKey = azureSharedKeyCredential(settings);
  const serviceClient = settings.objectStorageAzureConnectionString
    ? BlobServiceClient.fromConnectionString(settings.objectStorageAzureConnectionString)
    : new BlobServiceClient(azureBlobServiceUrl(settings), sharedKey);
  const containerClient = serviceClient.getContainerClient(settings.objectStorageBucket);

  return {
    bucket: settings.objectStorageBucket,
    backend: "azure-blob",
    maxSinglePutSizeBytes: MAX_SINGLE_PUT_SIZE_BYTES,
    async createPutUrl(args) {
      const expiresIn = args.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      const blobClient = containerClient.getBlockBlobClient(args.key);
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
      const blobClient = containerClient.getBlobClient(args.key);
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
      const blobClient = containerClient.getBlockBlobClient(args.key);
      const body = Buffer.from(args.body);
      await blobClient.upload(body, body.byteLength, {
        blobHTTPHeaders: { blobContentType: args.contentType },
        ...(args.sha256 ? { metadata: { sha256: args.sha256 } } : {}),
      });
    },
    async headFile(file) {
      return azureHeadToObjectHead(
        await containerClient.getBlobClient(file.objectKey).getProperties(),
      );
    },
    async getFileBytes(file) {
      return await azureDownloadToBytes(
        await containerClient.getBlobClient(file.objectKey).download(),
      );
    },
    async getObjectBytes(key) {
      try {
        const download = await containerClient.getBlobClient(key).download();
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
      await containerClient.getBlockBlobClient(key).deleteIfExists();
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

function objectHead(input: {
  contentLength?: number | undefined;
  contentType?: string | undefined;
  metadata?: Record<string, string> | undefined;
}): ObjectHead {
  return {
    ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
    ...(input.contentType !== undefined ? { ContentType: input.contentType } : {}),
    ...(input.metadata !== undefined ? { Metadata: input.metadata } : {}),
  };
}

export function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
