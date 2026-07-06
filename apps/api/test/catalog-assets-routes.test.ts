import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { catalogAssetKeyFromPath } from "../src/routes/catalog-assets";

const BUCKET = "catalog-assets-test-bucket";

function startFakeS3(objects: Record<string, { body: string; contentType: string }>): { url: string; close: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
      const object = objects[key];
      if (!object) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>not found</Message><Key>${key}</Key><RequestId>req-1</RequestId></Error>`,
          { status: 404, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response(object.body, { status: 200, headers: { "content-type": object.contentType } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

function appWithFakeStorage(fakeUrl: string | undefined, overrides: Partial<Settings> = {}) {
  const settings = testSettings({
    integrationsEnabled: true,
    objectStorageBackend: "s3-compatible",
    objectStorageBucket: BUCKET,
    objectStorageForcePathStyle: true,
    ...(fakeUrl ? { objectStorageEndpoint: fakeUrl, objectStorageAccessKeyId: "test", objectStorageSecretAccessKey: "test" } : {}),
    ...overrides,
  });
  return createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

describe("catalogAssetKeyFromPath", () => {
  test("requires the catalog-assets/ prefix", () => {
    expect(catalogAssetKeyFromPath("/v1/other-namespace/logo.png")).toBeNull();
  });

  test("rejects .. traversal, plain or percent-encoded", () => {
    expect(catalogAssetKeyFromPath("/v1/catalog-assets/../secret.png")).toBeNull();
    expect(catalogAssetKeyFromPath("/v1/catalog-assets/foo/%2e%2e/secret.png")).toBeNull();
  });

  test("rejects backslashes and double slashes", () => {
    expect(catalogAssetKeyFromPath("/v1/catalog-assets/foo%5Cbar.png")).toBeNull();
    expect(catalogAssetKeyFromPath("/v1/catalog-assets//foo.png")).toBeNull();
  });

  test("rejects non-printable-ASCII and over-length keys", () => {
    expect(catalogAssetKeyFromPath("/v1/catalog-assets/%00foo.png")).toBeNull();
    expect(catalogAssetKeyFromPath(`/v1/catalog-assets/${"a".repeat(600)}.png`)).toBeNull();
  });

  test("accepts a well-formed key", () => {
    expect(catalogAssetKeyFromPath("/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png"))
      .toBe("catalog-assets/integrations-sh/logos/example.com/abc123.png");
  });
});

describe("GET /v1/catalog-assets/*", () => {
  test("serves an existing object with immutable cache headers and honors If-None-Match", async () => {
    const fake = startFakeS3({ "catalog-assets/integrations-sh/logos/example.com/abc123.png": { body: "logo-bytes", contentType: "image/png" } });
    try {
      const app = appWithFakeStorage(fake.url);
      const response = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("logo-bytes");
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("etag")).toBe("\"abc123\"");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");

      const conditional = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png", {
        headers: { "if-none-match": "\"abc123\"" },
      });
      expect(conditional.status).toBe(304);
    } finally {
      fake.close();
    }
  });

  test("returns 404 for an unknown file extension without touching storage", async () => {
    const fake = startFakeS3({ "catalog-assets/integrations-sh/logos/example.com/payload.exe": { body: "nope", contentType: "application/octet-stream" } });
    try {
      const app = appWithFakeStorage(fake.url);
      const response = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/payload.exe");
      expect(response.status).toBe(404);
    } finally {
      fake.close();
    }
  });

  test("returns 404 for a missing object", async () => {
    const fake = startFakeS3({});
    try {
      const app = appWithFakeStorage(fake.url);
      const response = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/missing.png");
      expect(response.status).toBe(404);
    } finally {
      fake.close();
    }
  });

  test("returns 404 when object storage is not configured", async () => {
    const app = appWithFakeStorage(undefined);
    const response = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png");
    expect(response.status).toBe(404);
  });

  test("returns 404 when integrations are disabled for the deployment", async () => {
    const fake = startFakeS3({ "catalog-assets/integrations-sh/logos/example.com/abc123.png": { body: "logo-bytes", contentType: "image/png" } });
    try {
      const app = appWithFakeStorage(fake.url, { integrationsEnabled: false });
      const response = await app.request("/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png");
      expect(response.status).toBe(404);
    } finally {
      fake.close();
    }
  });

  test("rejects percent-encoded .. traversal at the HTTP layer", async () => {
    const fake = startFakeS3({});
    try {
      const app = appWithFakeStorage(fake.url);
      const response = await app.request("/v1/catalog-assets/foo/%2e%2e/secret.png");
      expect(response.status).toBe(404);
    } finally {
      fake.close();
    }
  });
});
