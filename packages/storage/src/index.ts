import type { Settings } from "@opengeni/config";
import type { FileAsset } from "@opengeni/contracts";
import {
  BlobSASPermissions,
  BlobServiceClient,
  BlockBlobClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  type BlobDownloadResponseParsed,
  type BlobGetPropertiesResponse,
} from "@azure/storage-blob";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  backend: "s3-compatible" | "azure-blob";
  maxSinglePutSizeBytes: number;
  createPutUrl: (args: { key: string; contentType: string; sha256?: string | null; expiresInSeconds?: number }) => Promise<{ url: string; requiredHeaders: Record<string, string>; expiresAt: Date }>;
  createGetUrl: (args: { key: string; expiresInSeconds?: number }) => Promise<{ url: string; expiresAt: Date }>;
  headFile: (file: FileAsset) => Promise<ObjectHead>;
  getFileBytes: (file: FileAsset) => Promise<Uint8Array>;
};

export function createObjectStorage(settings: Settings): ObjectStorage | null {
  if (settings.objectStorageBackend === "azure-blob") {
    return createAzureBlobObjectStorage(settings);
  }
  return createS3CompatibleObjectStorage(settings);
}

function createS3CompatibleObjectStorage(settings: Settings): ObjectStorage | null {
  if (!settings.objectStorageEndpoint || !settings.objectStorageAccessKeyId || !settings.objectStorageSecretAccessKey) {
    return null;
  }
  const client = new S3Client({
    endpoint: settings.objectStorageEndpoint,
    region: settings.objectStorageRegion,
    forcePathStyle: settings.objectStorageForcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: settings.objectStorageAccessKeyId,
      secretAccessKey: settings.objectStorageSecretAccessKey,
    },
  });
  return {
    bucket: settings.objectStorageBucket,
    backend: "s3-compatible",
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
        url: await getSignedUrl(client, new GetObjectCommand({
          Bucket: settings.objectStorageBucket,
          Key: args.key,
        }), { expiresIn }),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      };
    },
    async headFile(file) {
      const head = await client.send(new HeadObjectCommand({
        Bucket: file.bucket,
        Key: file.objectKey,
      }));
      return objectHead({
        contentLength: head.ContentLength,
        contentType: head.ContentType,
        metadata: head.Metadata,
      });
    },
    async getFileBytes(file) {
      const result = await client.send(new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.objectKey,
      }));
      if (!result.Body) {
        throw new Error(`Object body is empty: ${file.objectKey}`);
      }
      if (typeof result.Body.transformToByteArray === "function") {
        return await result.Body.transformToByteArray();
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array | Buffer | string>) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks);
    },
  };
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
      const sas = generateBlobSASQueryParameters({
        containerName: settings.objectStorageBucket,
        blobName: args.key,
        permissions: BlobSASPermissions.parse("cw"),
        expiresOn: expiresAt,
        contentType: args.contentType,
      }, sharedKey).toString();
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
      const sas = generateBlobSASQueryParameters({
        containerName: settings.objectStorageBucket,
        blobName: args.key,
        permissions: BlobSASPermissions.parse("r"),
        expiresOn: expiresAt,
      }, sharedKey).toString();
      return {
        url: `${blobClient.url}?${sas}`,
        expiresAt,
      };
    },
    async headFile(file) {
      return azureHeadToObjectHead(await containerClient.getBlobClient(file.objectKey).getProperties());
    },
    async getFileBytes(file) {
      return await azureDownloadToBytes(await containerClient.getBlobClient(file.objectKey).download());
    },
  };
}

function azureSharedKeyCredential(settings: Settings): StorageSharedKeyCredential {
  if (settings.objectStorageAzureConnectionString) {
    const parsed = parseConnectionString(settings.objectStorageAzureConnectionString);
    if (parsed.AccountName && parsed.AccountKey) {
      return new StorageSharedKeyCredential(parsed.AccountName, parsed.AccountKey);
    }
    throw new Error("Azure Blob connection string must include AccountName and AccountKey to create presigned URLs");
  }
  if (!settings.objectStorageAzureAccountName || !settings.objectStorageAzureAccountKey) {
    throw new Error("Azure Blob storage requires account name and account key");
  }
  return new StorageSharedKeyCredential(settings.objectStorageAzureAccountName, settings.objectStorageAzureAccountKey);
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
  return Object.fromEntries(value.split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    }));
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
  for await (const chunk of download.readableStreamBody as AsyncIterable<Uint8Array | Buffer | string>) {
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
