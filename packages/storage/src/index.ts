import type { Settings } from "@infra-agents/config";
import type { FileAsset } from "@infra-agents/contracts";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MAX_SINGLE_PUT_SIZE_BYTES = 5_000_000_000;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export type ObjectStorage = {
  bucket: string;
  maxSinglePutSizeBytes: number;
  createPutUrl: (args: { key: string; contentType: string; sha256?: string | null; expiresInSeconds?: number }) => Promise<{ url: string; requiredHeaders: Record<string, string>; expiresAt: Date }>;
  createGetUrl: (args: { key: string; expiresInSeconds?: number }) => Promise<{ url: string; expiresAt: Date }>;
  headFile: (file: FileAsset) => Promise<HeadObjectCommandOutput>;
  getFileBytes: (file: FileAsset) => Promise<Uint8Array>;
};

export function createObjectStorage(settings: Settings): ObjectStorage | null {
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
      return await client.send(new HeadObjectCommand({
        Bucket: file.bucket,
        Key: file.objectKey,
      }));
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

export function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
