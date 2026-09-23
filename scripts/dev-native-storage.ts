#!/usr/bin/env bun
// Native development fixtures only. Never point this provisioner at remote storage.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const garageVersion = "2.3.0";
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

export function garagePlatform(platform = process.platform, arch = process.arch): "binary" {
  if (platform === "win32")
    throw new Error(
      "Native Windows Garage is unsupported. Run the entire native stack inside WSL2 (Linux), not Git Bash or WSL1.",
    );
  if (platform === "darwin")
    throw new Error(
      "Native Garage on macOS is not supported by this setup. Use OPENGENI_DEV_BACKEND=docker with a running Docker daemon, or run the native stack on Linux/WSL2.",
    );
  if (platform !== "linux") throw new Error(`Unsupported native Garage platform: ${platform}`);
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Native Garage supports x64/arm64 only, not ${arch}`);
  return "binary";
}
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function resolveGarageBinary(which = Bun.which): string {
  garagePlatform();
  // The bootstrap installer owns distribution verification and puts the
  // OCI-digest-verified executable on PATH. Never add a weaker download fallback.
  const binary = which("garage");
  if (!binary)
    throw new Error(
      "Garage 2.3.0 is missing from PATH. Run the development tools bootstrap, or use OPENGENI_DEV_BACKEND=docker.",
    );
  const version = Bun.spawnSync([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  if (version.exitCode !== 0 || !/^garage v2\.3\.0(?:\s|$)/.test(version.stdout.toString().trim()))
    throw new Error(
      "Native storage requires Garage 2.3.0. Run the development tools bootstrap and use its project-local bin directory on PATH.",
    );
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
        "Usage: dev-native-storage.ts <resolve|binary|configure|provision|record> <state-dir> [provider]",
      );
    const state = resolve(stateArg);
    switch (command) {
      case "resolve":
        console.log(resolveFixture(state, requested));
        break;
      case "binary":
        console.log(resolveGarageBinary());
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
