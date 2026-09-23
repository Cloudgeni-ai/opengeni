#!/usr/bin/env bun
// Native development fixtures only. Never point this provisioner at remote storage.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const garageVersion = "2.3.0";
// Official release bytes, not a moving package-manager formula or latest URL.
export const garageReleases = {
  x64: {
    target: "x86_64-unknown-linux-musl",
    sha256: "f98d317942bb341151a2775162016bb50cf86b865d0108de03eb5db16e2120cd",
  },
  arm64: {
    target: "aarch64-unknown-linux-musl",
    sha256: "8ced2ad3040262571de08aa600959aa51f97576d55da7946fcde6f66140705e2",
  },
} as const;
const sourceDigest = "b83a981677676b35400bbbaf20974c396f32da31c7c7630ce55fc3e62c0e2e01";
export type Fixture = "garage" | "minio";
export function resolveFixture(state: string, requested?: string): Fixture {
  if (requested && requested !== "garage" && requested !== "minio")
    throw new Error("OPENGENI_OBJECT_STORAGE_FIXTURE must be garage or minio");
  const marker = join(state, "storage-provider");
  const recorded = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
  if (recorded && recorded !== "garage" && recorded !== "minio")
    throw new Error("Invalid native storage-provider marker");
  // Even empty legacy directories are evidence: never silently reinterpret them.
  const minio = existsSync(join(state, "minio")) || existsSync(join(state, "pids/minio.pid"));
  const garage = existsSync(join(state, "garage")) || existsSync(join(state, "pids/garage.pid"));
  if ((minio && garage) || (recorded === "garage" && minio) || (recorded === "minio" && garage))
    throw new Error("Conflicting native storage state; preserve and inspect it before continuing");
  const existing = recorded || (minio ? "minio" : garage ? "garage" : undefined);
  if (requested && existing && requested !== existing)
    throw new Error(
      `Native storage contains ${existing} state; refusing to switch to ${requested}. Use the recorded provider, or explicitly clean/back up this project first.`,
    );
  return (existing || requested || "garage") as Fixture;
}

export function garagePlatform(
  platform = process.platform,
  arch = process.arch,
): "binary" | "source" {
  if (platform === "win32")
    throw new Error(
      "Native Windows Garage is unsupported. Run the entire native stack inside WSL2 (Linux), not Git Bash or WSL1.",
    );
  if (platform !== "linux" && platform !== "darwin")
    throw new Error(`Unsupported native Garage platform: ${platform}`);
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Native Garage supports x64/arm64 only, not ${arch}`);
  return platform === "darwin" ? "source" : "binary";
}
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
async function download(url: string, path: string, digest: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Garage download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== digest) throw new Error("Garage release checksum mismatch");
  writeFileSync(path, bytes, { mode: 0o600 });
}
async function run(args: string[]) {
  // stdout is reserved for the installed binary path (shell command substitution).
  const child = Bun.spawn(args, { stdout: 2, stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`);
}
export async function installGarage(state: string) {
  const mode = garagePlatform();
  const directory = join(
    state,
    "runtime",
    `garage-${garageVersion}-${process.platform}-${process.arch}`,
  );
  const binary = join(directory, "garage");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = garageReleases[process.arch as keyof typeof garageReleases];
  if (existsSync(binary)) {
    if (mode === "binary" && sha256(readFileSync(binary)) !== release.sha256)
      throw new Error("Cached Garage binary checksum mismatch");
    return binary;
  }
  if (mode === "binary") {
    await download(
      `https://garagehq.deuxfleurs.fr/_releases/v${garageVersion}/${release.target}/garage`,
      `${binary}.tmp`,
      release.sha256,
    );
  } else {
    if (!Bun.which("cargo") || !Bun.which("cc"))
      throw new Error(
        "macOS Garage requires cargo and Xcode Command Line Tools for the pinned source build",
      );
    const archive = join(directory, "source.tar.gz");
    await download(
      `https://git.deuxfleurs.fr/Deuxfleurs/garage/archive/v${garageVersion}.tar.gz`,
      archive,
      sourceDigest,
    );
    const source = join(directory, "source");
    mkdirSync(source, { recursive: true });
    await run(["tar", "-xzf", archive, "--strip-components=1", "-C", source]);
    console.error("Building pinned Garage 2.3.0 for macOS; first build can take several minutes.");
    await run([
      "cargo",
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      join(source, "Cargo.toml"),
      "--target-dir",
      join(directory, "target"),
      "-p",
      "garage",
      "--no-default-features",
      "--features",
      "bundled-libs,sqlite",
    ]);
    writeFileSync(`${binary}.tmp`, readFileSync(join(directory, "target/release/garage")), {
      mode: 0o700,
    });
  }
  chmodSync(`${binary}.tmp`, 0o700);
  renameSync(`${binary}.tmp`, binary);
  return binary;
}

export function storageSettings(env = process.env) {
  const port = Number(env.OPENGENI_GARAGE_HOST_PORT || 3900);
  const rpcPort = Number(env.OPENGENI_GARAGE_RPC_HOST_PORT || 3901);
  if (![port, rpcPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) || port === rpcPort)
    throw new Error("Garage requires two distinct valid host ports");
  const bucket = env.OPENGENI_OBJECT_STORAGE_BUCKET || "opengeni-files";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error("Invalid native storage bucket name");
  const accessKey =
    env.OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID || "GK0123456789abcdef0123456789abcdef";
  const secretKey =
    env.OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY ||
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  if (!/^GK[0-9a-f]{32}$/.test(accessKey) || !/^[0-9a-f]{64}$/.test(secretKey))
    throw new Error(
      "Garage needs a GK + 32 hex access key and a 64 hex secret; refusing to replace configured credentials",
    );
  return { port, rpcPort, bucket, accessKey, secretKey };
}

export function configureGarage(state: string, settings = storageSettings()) {
  const directory = join(state, "garage");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secretFile = join(directory, "rpc-secret");
  if (!existsSync(secretFile))
    writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const secret = readFileSync(secretFile, "utf8");
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid saved Garage RPC secret");
  const config = join(directory, "garage.toml");
  writeFileSync(
    config,
    [
      `metadata_dir = ${JSON.stringify(join(directory, "meta"))}`,
      `data_dir = ${JSON.stringify(join(directory, "data"))}`,
      'db_engine = "sqlite"',
      "replication_factor = 1",
      `rpc_bind_addr = "127.0.0.1:${settings.rpcPort}"`,
      `rpc_public_addr = "127.0.0.1:${settings.rpcPort}"`,
      `rpc_secret = "${secret}"`,
      "[s3_api]",
      's3_region = "us-east-1"',
      `api_bind_addr = "127.0.0.1:${settings.port}"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return config;
}

// Minimal SigV4 for the local fixture's CORS API; no AWS SDK install or mc needed.
export function signedRequest(
  url: URL,
  method: string,
  body: string,
  accessKey: string,
  secretKey: string,
  now = new Date(),
) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const hash = sha256(body);
  const headers = { host: url.host, "x-amz-content-sha256": hash, "x-amz-date": date };
  const names = Object.keys(headers).join(";");
  const canonical = [
    method,
    url.pathname,
    url.searchParams.toString(),
    Object.entries(headers)
      .map(([k, v]) => `${k}:${v}\n`)
      .join(""),
    names,
    hash,
  ].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), "us-east-1"), "s3"), "aws4_request");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names}, Signature=${hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`).toString("hex")}`,
  };
}
export async function provisionGarage(settings = storageSettings()) {
  const body = readFileSync(new URL("../deploy/garage/cors.xml", import.meta.url), "utf8");
  const url = new URL(`http://127.0.0.1:${settings.port}/${settings.bucket}?cors=`);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        body,
        headers: signedRequest(url, "PUT", body, settings.accessKey, settings.secretKey),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
      await response.body?.cancel();
      if (response.status !== 404 && response.status !== 503)
        throw new Error(`Garage CORS provisioning failed: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Garage CORS")) throw error;
    }
    await Bun.sleep(200);
  }
  throw new Error("Garage bucket/CORS provisioning timed out");
}

if (import.meta.main) {
  try {
    const [command, stateArg, requested] = process.argv.slice(2);
    if (!stateArg)
      throw new Error(
        "Usage: dev-native-storage.ts <resolve|install|configure|provision|record> <state-dir> [provider]",
      );
    const state = resolve(stateArg);
    switch (command) {
      case "resolve":
        console.log(resolveFixture(state, requested));
        break;
      case "install":
        console.log(await installGarage(state));
        break;
      case "configure":
        console.log(configureGarage(state));
        break;
      case "provision":
        await provisionGarage();
        break;
      case "record": {
        const fixture = resolveFixture(state, requested);
        mkdirSync(state, { recursive: true });
        writeFileSync(join(state, "storage-provider"), `${fixture}\n`, { mode: 0o600 });
        break;
      }
      default:
        throw new Error(`Unknown native storage command: ${command}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native storage failed");
    process.exitCode = 1;
  }
}
