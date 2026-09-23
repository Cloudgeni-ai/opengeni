/** Reproduce native Garage pins without Docker:
 * OPENGENI_VERIFY_GARAGE_PROVENANCE=1 bun test scripts/install-development-tools.garage-provenance.test.ts
 * This is a maintainer verification test, NOT runtime OCI installation machinery.
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import provenance from "./install-development-tools.garage-provenance.json";
import { assetFor, detectTarget, downloadAsset, sha256 } from "./install-development-tools";

const digest = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`;
const encoded = (value: unknown, pretty = false) => Buffer.from(JSON.stringify(value, null, pretty ? 2 : undefined));

test("Garage binary pins trace to the existing compose image's exact manifest chain", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  expect(compose).toContain(provenance.image);
  expect(digest(encoded(provenance.index, true))).toBe(provenance.indexDigest);
  for (const arch of ["amd64", "arm64"] as const) {
    const target = provenance.targets[arch];
    const descriptor = provenance.index.manifests.find((m) => m.platform.os === "linux" && m.platform.architecture === arch)!;
    expect(descriptor.digest).toBe(target.manifestDigest);
    expect(digest(encoded(target.manifest))).toBe(descriptor.digest);
    expect(encoded(target.manifest).length).toBe(descriptor.size);
    expect(target.manifest.layers).toHaveLength(1);
    const asset = assetFor("garage", detectTarget("linux", arch === "amd64" ? "x64" : "arm64", "6"));
    expect(asset.sha256).toBe(target.binarySha256);
    expect(asset.url).toBe(target.nativeUrl);
  }
});

function timestampsOnly(pax: Buffer) {
  for (let offset = 0; offset < pax.length;) {
    const space = pax.indexOf(32, offset);
    if (space < 0 || !/^[1-9][0-9]*$/.test(pax.subarray(offset, space).toString())) throw new Error("Invalid PAX length");
    const length = Number(pax.subarray(offset, space).toString());
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > pax.length) throw new Error("Invalid PAX bound");
    const record = pax.subarray(space + 1, offset + length).toString();
    if (!/^(atime|ctime|mtime)=[0-9]+(?:\.[0-9]+)?\n$/.test(record)) throw new Error("Only PAX timestamps permitted (no path/link/size overrides)");
    offset += length;
  }
}

test("Garage provenance PAX handling never accepts path or size overrides", () => {
  expect(() => timestampsOnly(Buffer.from("30 atime=1776370543.952267766\n"))).not.toThrow();
  for (const record of ["18 path=../garage\n", "12 size=123\n", "19 linkpath=garage\n", "999999 atime=1\n", "nonsense"]) {
    expect(() => timestampsOnly(Buffer.from(record))).toThrow();
  }
});

/** This pinned single-layer image has precisely these four records. No overlay
 * interpretation: whiteouts, links, further layers and unknown PAX fields fail.
 * Nothing is extracted to disk, including the absolute root metadata record.
 */
function garageFromPinnedLayer(tar: Buffer): Buffer {
  const expected = [["/PaxHeaders.0", "x"], ["/", "5"], ["PaxHeaders.0/garage", "x"], ["garage", "0"]];
  let offset = 0;
  let binary: Buffer | undefined;
  for (const [expectedName, expectedType] of expected) {
    if (offset + 512 > tar.length) throw new Error("Truncated layer");
    const header = tar.subarray(offset, offset + 512);
    const field = (a: number, b: number) => header.subarray(a, b).toString().split("\0")[0]!;
    const number = (a: number, b: number) => {
      const value = field(a, b).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar number");
      return Number.parseInt(value, 8);
    };
    if (number(148, 156) !== header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)) throw new Error("Tar checksum mismatch");
    const prefix = field(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
    const type = field(156, 157);
    if (name !== expectedName || type !== expectedType || field(157, 257) !== "") throw new Error("Unexpected layer entry; no links or whiteouts accepted");
    const size = number(124, 136);
    if (!Number.isSafeInteger(size) || size > 100 * 1024 * 1024 || offset + 512 + size > tar.length) throw new Error("Layer size bound");
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "x") timestampsOnly(bytes);
    else if (type === "5" && size !== 0) throw new Error("Directory has data");
    else if (type === "0") {
      if (!(number(100, 108) & 0o111) || size === 0) throw new Error("Garage is not an executable");
      binary = bytes;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary || tar.length - offset < 1024 || !tar.subarray(offset).every((b) => b === 0)) throw new Error("Unexpected trailing layer content");
  return binary;
}

// Public registry requests only. Auth is sent solely to the registry origin,
// never its CDN. Redirect hosts, request duration and response size are bounded.
async function registryGet(url: string, token = "", maxBytes = 1024 * 1024): Promise<Buffer> {
  const allowed = new Set(["auth.docker.io", "registry-1.docker.io", "production.cloudfront.docker.com", "production.cloudflare.docker.com"]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error("Unexpected OCI origin");
      const headers: Record<string, string> = { Accept: "application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" };
      if (parsed.hostname === "registry-1.docker.io" && token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { headers, redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Missing OCI redirect");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`OCI HTTP ${response.status}`); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("OCI response exceeds bound");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    throw new Error("Too many OCI redirects");
  } finally { clearTimeout(timeout); }
}

test.skipIf(process.env.OPENGENI_VERIFY_GARAGE_PROVENANCE !== "1")("live: both native Garage binaries match the digest-verified official OCI image", async () => {
  const auth = JSON.parse((await registryGet("https://auth.docker.io/token?service=registry.docker.io&scope=repository:dxflrs/garage:pull")).toString()) as { token: string };
  if (typeof auth.token !== "string" || !auth.token) throw new Error("Missing public registry token");
  const base = "https://registry-1.docker.io/v2/dxflrs/garage";
  const index = await registryGet(`${base}/manifests/${provenance.indexDigest}`, auth.token);
  expect(digest(index)).toBe(provenance.indexDigest);
  expect(JSON.parse(index.toString())).toEqual(provenance.index);
  for (const arch of ["amd64", "arm64"] as const) {
    const target = provenance.targets[arch];
    const manifest = await registryGet(`${base}/manifests/${target.manifestDigest}`, auth.token);
    expect(digest(manifest)).toBe(target.manifestDigest);
    expect(JSON.parse(manifest.toString())).toEqual(target.manifest);
    const configBytes = await registryGet(`${base}/blobs/${target.manifest.config.digest}`, auth.token);
    expect(digest(configBytes)).toBe(target.manifest.config.digest);
    expect(configBytes.length).toBe(target.manifest.config.size);
    const config = JSON.parse(configBytes.toString());
    expect(config.architecture).toBe(arch);
    expect(config.os).toBe("linux");
    const descriptor = target.manifest.layers[0]!;
    const layer = await registryGet(`${base}/blobs/${descriptor.digest}`, auth.token, 100 * 1024 * 1024);
    expect(digest(layer)).toBe(descriptor.digest);
    expect(layer.length).toBe(descriptor.size);
    const tar = gunzipSync(layer, { maxOutputLength: 100 * 1024 * 1024 });
    expect(config.rootfs.diff_ids).toEqual([digest(tar)]);
    const binary = garageFromPinnedLayer(tar);
    expect(binary.length).toBe(target.binarySize);
    expect(sha256(binary)).toBe(target.binarySha256);
    const native = await downloadAsset(target.nativeUrl);
    expect(sha256(native)).toBe(target.binarySha256);
    expect(Buffer.from(native).equals(binary)).toBe(true);
  }
}, 300_000);