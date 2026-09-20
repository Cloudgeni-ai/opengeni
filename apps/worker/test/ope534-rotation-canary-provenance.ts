import { createHash } from "node:crypto";
import { z } from "zod";
import { requireCanary } from "./ope534-rotation-canary-evidence";

const REPOSITORY = "ghcr.io/cloudgeni-ai/opengeni-sandbox";
const BASE = "https://ghcr.io/v2/cloudgeni-ai/opengeni-sandbox";
const TOKEN =
  "https://ghcr.io/token?service=ghcr.io&scope=repository:cloudgeni-ai/opengeni-sandbox:pull";
const SOURCE = "https://github.com/Cloudgeni-ai/opengeni";
const MAX_BYTES = 1024 * 1024;
const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(", ");
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Descriptor = z.object({ digest: Digest, size: z.number().int().positive().max(MAX_BYTES) });
const Index = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string(),
  manifests: z.array(
    Descriptor.extend({
      platform: z
        .object({ os: z.string(), architecture: z.string(), variant: z.string().optional() })
        .optional(),
    }),
  ),
});
const Manifest = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string(),
  config: Descriptor,
});
const Configuration = z.object({
  os: z.literal("linux"),
  architecture: z.literal("amd64"),
  config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Verify the source identity embedded by canonical .github/workflows/ci.yml
 * sandbox-image labels. This reads only immutable GHCR digests, verifies every
 * byte-hash edge (index -> linux/amd64 manifest -> config), and does NOT accept a
 * caller-authored receipt, mutable tag, alternate registry, or runtime-written
 * /workspace marker as provenance. No Docker/provider allocation is needed. */
export async function verifyCanaryImageProvenance(
  sourceSha: string,
  image: string,
  request: Fetch = fetch,
) {
  requireCanary(/^[a-f0-9]{40}$/.test(sourceSha), "invalid provenance source SHA");
  requireCanary(
    image.startsWith(`${REPOSITORY}@`),
    "only canonical GHCR sandbox provenance is supported",
  );
  const imageDigest = Digest.parse(image.slice(REPOSITORY.length + 1));
  const tokenResponse = await readBounded(TOKEN, {}, request);
  const { token } = z.object({ token: z.string().min(1) }).parse(parseRegistryJson(tokenResponse));
  // Token is anonymous pull-only and never leaves GHCR or enters the receipt.
  const headers = { Authorization: `Bearer ${token}`, Accept: ACCEPT };
  const readObject = async (kind: "manifests" | "blobs", digest: string, size?: number) => {
    const bytes = await readBounded(`${BASE}/${kind}/${digest}`, headers, request);
    requireCanary(size === undefined || bytes.byteLength === size, "OCI descriptor size mismatch");
    requireCanary(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest,
      "OCI digest verification failed",
    );
    return parseRegistryJson(bytes);
  };
  let manifestDigest = imageDigest;
  let value = await readObject("manifests", imageDigest);
  const media = z.object({ mediaType: z.string() }).parse(value).mediaType;
  if (INDEX_TYPES.includes(media)) {
    const index = Index.parse(value);
    const matching = index.manifests.filter(
      (entry) =>
        entry.platform?.os === "linux" &&
        entry.platform.architecture === "amd64" &&
        !entry.platform.variant,
    );
    requireCanary(
      matching.length === 1,
      "OCI index must select exactly one stock linux/amd64 image",
    );
    manifestDigest = matching[0]!.digest;
    value = await readObject("manifests", manifestDigest, matching[0]!.size);
  }
  const manifest = Manifest.parse(value);
  requireCanary(MANIFEST_TYPES.includes(manifest.mediaType), "unsupported OCI image manifest");
  const config = Configuration.parse(
    await readObject("blobs", manifest.config.digest, manifest.config.size),
  );
  requireCanary(
    config.config.Labels["org.opencontainers.image.revision"] === sourceSha,
    "immutable image was not built from the pinned source SHA",
  );
  requireCanary(
    config.config.Labels["org.opencontainers.image.source"] === SOURCE,
    "immutable image has the wrong source repository",
  );
  return {
    kind: "oci-config-source-identity" as const,
    sourceSha,
    sourceRepository: SOURCE,
    image,
    imageDigest,
    manifestDigest,
    configDigest: manifest.config.digest,
    platform: "linux/amd64" as const,
  };
}

async function readBounded(
  url: string,
  headers: Record<string, string>,
  request: Fetch,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const parsed = new URL(url);
    requireCanary(
      parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        ["ghcr.io", "pkg-containers.githubusercontent.com"].includes(parsed.hostname),
      "untrusted registry redirect",
    );
    let response: Response;
    try {
      response = await request(url, {
        headers: parsed.hostname === "ghcr.io" ? headers : {},
        redirect: "manual",
        signal,
      });
    } catch {
      // Transport errors may contain signed blob URLs. Do not retain them as
      // error causes or expose them in the canary test runner's output.
      throw new Error("OPE534 canary: canonical registry transport failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      requireCanary(location && redirects < 2, "registry redirect limit exceeded");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("OPE534 canary: canonical registry object is unavailable");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      await response.body.cancel();
      throw new Error("OPE534 canary: registry object exceeds bounded metadata size");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        requireCanary(size <= MAX_BYTES, "registry object exceeds bounded metadata size");
        chunks.push(part.value);
      }
    } catch {
      throw new Error("OPE534 canary: registry metadata stream failed or exceeded its bound");
    } finally {
      try {
        await reader.cancel();
      } catch {
        throw new Error("OPE534 canary: registry metadata stream cleanup failed");
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error("OPE534 canary: registry redirect did not resolve");
}

function parseRegistryJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("OPE534 canary: invalid registry metadata JSON");
  }
}
