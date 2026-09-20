import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyCanaryImageProvenance } from "./ope534-rotation-canary-provenance";

const sha = "a".repeat(40);
const repository = "ghcr.io/cloudgeni-ai/opengeni-sandbox";
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fixture(
  options: {
    revision?: string;
    source?: string;
    corrupt?: "index" | "manifest" | "config";
    duplicate?: boolean;
    architecture?: string;
    redirect?: string;
    oversized?: boolean;
    direct?: boolean;
  } = {},
) {
  const config = JSON.stringify({
    os: "linux",
    architecture: options.architecture ?? "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.revision": options.revision ?? sha,
        "org.opencontainers.image.source":
          options.source ?? "https://github.com/Cloudgeni-ai/opengeni",
      },
    },
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: digest(config), size: Buffer.byteLength(config) },
  });
  const entry = {
    digest: digest(manifest),
    size: Buffer.byteLength(manifest),
    platform: { os: "linux", architecture: "amd64" },
  };
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: options.duplicate ? [entry, entry] : [entry],
  });
  const image = `${repository}@${digest(options.direct ? manifest : index)}`;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.startsWith("https://ghcr.io/token?"))
      return Response.json({ token: "test-anonymous-pull-token" });
    if (url.includes("/blobs/")) {
      if (options.redirect)
        return new Response(null, { status: 307, headers: { location: options.redirect } });
      return new Response(options.corrupt === "config" ? config.replace("linux", "linuz") : config);
    }
    if (url.startsWith("https://pkg-containers.githubusercontent.com/"))
      return new Response(config);
    if (url.endsWith(digest(index)))
      return new Response(
        options.corrupt === "index"
          ? index.replace('"schemaVersion":2', '"schemaVersion":3')
          : index,
        options.oversized ? { headers: { "content-length": "1048577" } } : {},
      );
    if (url.endsWith(digest(manifest)))
      return new Response(
        options.corrupt === "manifest" ? manifest.replace('"config"', '"konfig"') : manifest,
      );
    throw new Error("unexpected registry request");
  };
  return { image, request, calls };
}

test("binds canonical immutable image to source through verified OCI hash edges", async () => {
  const f = fixture();
  const proof = await verifyCanaryImageProvenance(sha, f.image, f.request);
  expect(proof).toMatchObject({
    kind: "oci-config-source-identity",
    sourceSha: sha,
    image: f.image,
    platform: "linux/amd64",
  });
  expect(JSON.stringify(proof)).not.toContain("test-anonymous-pull-token");
});
test("supports a digest-pinned single-platform manifest too", async () => {
  const f = fixture({ direct: true });
  expect((await verifyCanaryImageProvenance(sha, f.image, f.request)).manifestDigest).toBe(
    f.image.split("@")[1]!,
  );
});
for (const [name, options] of [
  ["stale image", { revision: "b".repeat(40) }],
  ["wrong repository", { source: "https://github.com/other/project" }],
  ["tampered index", { corrupt: "index" }],
  ["tampered child manifest", { corrupt: "manifest" }],
  ["tampered config", { corrupt: "config" }],
  ["ambiguous platform", { duplicate: true }],
  ["wrong architecture", { architecture: "arm64" }],
  ["oversized metadata", { oversized: true }],
  ["untrusted redirect", { redirect: "https://example.invalid/blob" }],
] as const)
  test(`rejects ${name}`, async () => {
    const f = fixture(options);
    await expect(verifyCanaryImageProvenance(sha, f.image, f.request)).rejects.toThrow();
  });
test("does not forward registry token to the allowlisted blob host", async () => {
  const f = fixture({ redirect: "https://pkg-containers.githubusercontent.com/image-config" });
  await verifyCanaryImageProvenance(sha, f.image, f.request);
  expect(f.calls.at(-1)?.authorization).toBeNull();
});
test("rejects alternate registry or mutable tag before making requests", async () => {
  const f = fixture();
  await expect(
    verifyCanaryImageProvenance(sha, f.image.replace("ghcr.io", "example.invalid"), f.request),
  ).rejects.toThrow();
  await expect(
    verifyCanaryImageProvenance(sha, `${repository}:latest`, f.request),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("verifies child/config bytes even when the descriptor size still matches", async () => {
  for (const corrupt of ["manifest", "config"] as const) {
    const f = fixture({ corrupt });
    await expect(verifyCanaryImageProvenance(sha, f.image, f.request)).rejects.toThrow(
      "OCI digest verification failed",
    );
  }
});

test("does not expose signed URLs from transport failures", async () => {
  const f = fixture();
  const request = async () => {
    throw new Error("https://pkg-containers.githubusercontent.com/blob?secret=test-value");
  };
  await expect(verifyCanaryImageProvenance(sha, f.image, request)).rejects.toThrow(
    "canonical registry transport failed",
  );
});

test("does not echo malformed token JSON", async () => {
  const f = fixture();
  await expect(
    verifyCanaryImageProvenance(sha, f.image, async () => new Response("test-secret-token{")),
  ).rejects.toThrow("invalid registry metadata JSON");
});

test("bounds streamed metadata without a content-length header", async () => {
  const f = fixture();
  let cancelled = false;
  const request = async (url: string, init?: RequestInit) => {
    if (url.includes("/token?")) return f.request(url, init);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1048577));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  await expect(verifyCanaryImageProvenance(sha, f.image, request)).rejects.toThrow(
    "exceeded its bound",
  );
  expect(cancelled).toBe(true);
});
