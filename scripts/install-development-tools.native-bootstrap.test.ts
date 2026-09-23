import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assetFor, detectTarget, downloadAsset, extractBinary, garageDiagnostic, installBinary, parseArgs, sha256, toolBin } from "./install-development-tools";

const target = detectTarget("linux", "x64", "6.0");
const asset = assetFor("temporal", target);
function archive(entries: { name: string; type?: string; body?: string }[]) {
  const blocks: Buffer[] = [];
  for (const { name, type = "0", body = "binary" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    data.write(body);
    blocks.push(header, data);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function extract(entries: Parameters<typeof archive>[0]) {
  const bytes = archive(entries);
  return extractBinary(bytes, { ...asset, sha256: sha256(bytes) });
}

describe("native prerequisite bootstrap", () => {
  test("explicit opt-in and selection, no ambiguous arguments", () => {
    expect(parseArgs([]).install).toBe(false);
    expect(parseArgs(["--install", "--tools=nats,temporal", "--json"])).toEqual({ install: true, json: true, tools: ["nats", "temporal"] });
    for (const argument of ["--force", "--tools=", "--tools=nats,nats", "--tools=rust"]) expect(() => parseArgs([argument])).toThrow();
  });
  test("target matrix is explicit; native Windows and WSL1 fail closed", () => {
    expect(detectTarget("darwin", "arm64", "24").arch).toBe("arm64");
    expect(detectTarget("linux", "x64", "6.6.87.2-microsoft-standard-WSL2").wsl2).toBe(true);
    expect(() => detectTarget("win32", "x64", "10")).toThrow("WSL2");
    expect(() => detectTarget("linux", "x64", "4.4.0-Microsoft")).toThrow("WSL1");
    expect(() => detectTarget("freebsd", "x64", "14")).toThrow("Unsupported OS");
    expect(() => detectTarget("linux", "riscv64", "6")).toThrow("Unsupported architecture");
  });
  test("all supported assets are pinned to official HTTPS releases/checksums", () => {
    for (const os of ["linux", "darwin"] as const) for (const cpu of ["x64", "arm64"] as const) {
      for (const name of ["nats", "temporal"] as const) {
        const selected = assetFor(name, detectTarget(os, cpu, "6"));
        expect(selected.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(selected.url).toStartWith("https://github.com/");
        expect(selected.url).toContain(selected.version);
        expect(selected.checksumSource).toMatch(/SHA256SUMS|checksums.txt/);
      }
    }
    expect(garageDiagnostic(detectTarget("darwin", "arm64", "24"))).toContain("no official macOS binary");
    expect(garageDiagnostic(target)).toContain("derived from the existing digest-pinned official Docker image");
    expect(() => assetFor("garage", detectTarget("darwin", "arm64", "24"))).toThrow("no official macOS binary");
    for (const cpu of ["x64", "arm64"]) {
      const selected = assetFor("garage", detectTarget("linux", cpu, "6"));
      expect(selected.format).toBe("binary");
      expect(selected.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(selected.checksumSource).toContain("dxflrs/garage:v2.3.0@sha256:");
    }
  });
  test("raw Garage binaries also fail closed on checksum mismatch", () => {
    const selected = assetFor("garage", target);
    expect(() => extractBinary(Buffer.from("unverified binary"), selected)).toThrow("SHA-256 mismatch");
    const bytes = Buffer.from("verified fixture");
    expect(extractBinary(bytes, { ...selected, sha256: sha256(bytes) })).toEqual(bytes);
  });
  test("verifies before parsing and extracts only intended member", () => {
    expect(() => extractBinary(Buffer.from("bad"), asset)).toThrow("SHA-256 mismatch");
    expect(extract([{ name: "LICENSE", body: "license" }, { name: "temporal" }]).toString()).toBe("binary");
    expect(() => extract([{ name: "other" }])).toThrow("Missing binary");
    expect(() => extract([{ name: "temporal" }, { name: "temporal" }])).toThrow("duplicate");
  });
  test("rejects traversal, absolute paths, symlinks, hardlinks and extension records", () => {
    for (const name of ["../escape", "/absolute", "a/../b", "a\\b", "./temporal", "a//b"]) expect(() => extract([{ name }])).toThrow("Unsafe tar path");
    for (const type of ["1", "2", "x", "g", "L"]) expect(() => extract([{ name: "temporal", type }])).toThrow("Unsupported tar entry");
  });
  test("rejects untrusted download origins before networking", async () => {
    for (const url of ["http://github.com/file", "https://example.com/file", "https://github.com:8443/file", "https://user@github.com/file"]) await expect(downloadAsset(url)).rejects.toThrow("Untrusted");
  });
  test("redirects cannot leave official hosts and loops are bounded", async () => {
    const original = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://example.com/payload" } }); }) as typeof fetch;
      await expect(downloadAsset(asset.url)).rejects.toThrow("Untrusted");
      expect(calls).toBe(1);
      calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response(null, { status: 302, headers: { location: asset.url } }); }) as typeof fetch;
      await expect(downloadAsset(asset.url)).rejects.toThrow("Too many");
      expect(calls).toBe(5);
      globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
      await expect(downloadAsset(asset.url)).rejects.toThrow("HTTP 404");
    } finally { globalThis.fetch = original; }
  });
  test("corrupt tar headers are rejected even with a matching archive hash", () => {
    const bytes = gzipSync(Buffer.alloc(1024, 42));
    expect(() => extractBinary(bytes, { ...asset, sha256: sha256(bytes) })).toThrow();
  });
  test("repeat installation is identical; existing modified tools remain untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-bootstrap-test-"));
    try {
      const bytes = Buffer.from("verified fixture");
      const path = await installBinary(root, target, asset, bytes);
      expect(path).toBe(join(toolBin(root, target), "temporal"));
      expect(await installBinary(root, target, asset, bytes)).toBe(path);
      await writeFile(path, "user-owned");
      await expect(installBinary(root, target, asset, bytes)).rejects.toThrow("preserving");
      expect(await readFile(path, "utf8")).toBe("user-owned");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("project directory symlink cannot redirect installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-bootstrap-symlink-"));
    try {
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, ".opengeni"));
      await expect(installBinary(root, target, asset, Buffer.from("fixture"))).rejects.toThrow("symlink");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("existing binary symlink is never followed or overwritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-bootstrap-binary-link-"));
    try {
      const directory = toolBin(root, target);
      await mkdir(directory, { recursive: true });
      const userFile = join(root, "user-file");
      await writeFile(userFile, "keep me");
      await symlink(userFile, join(directory, "temporal"));
      await expect(installBinary(root, target, asset, Buffer.from("fixture"))).rejects.toThrow("preserving");
      expect(await readFile(userFile, "utf8")).toBe("keep me");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});