// Getting the connected-machine agent onto this computer: which release file
// fits it, and whether a downloaded file is the one the release signed. The
// agent is too large to ship inside the app, so the app downloads it the first
// time someone connects this computer, from the server they connect to, and
// trusts it only when its minisign signature checks out against the pinned key.

import { createHash, createPublicKey, verify, type Hash } from "node:crypto";

import type { AgentPlatform } from "./agent-cli";

/** The release file of the agent for this system, as servers serve it under `/agent/latest/`. */
export function agentAssetName(platform: AgentPlatform, arch: string): string | null {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (platform === "darwin") return "opengeni-agent-universal-apple-darwin";
  if (!cpu) return null;
  if (platform === "linux") return `opengeni-agent-${cpu}-unknown-linux-musl`;
  return `opengeni-agent-${cpu}-pc-windows-msvc.exe`;
}

interface PublicKey {
  keyId: Buffer;
  key: Buffer;
}

interface Signature {
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

/** A minisign public key line (`RW…`): "Ed", an 8-byte key id, a 32-byte Ed25519 key. */
export function parsePublicKey(line: string): PublicKey {
  const bytes = Buffer.from(line.trim(), "base64");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("not a minisign public key");
  }
  return { keyId: bytes.subarray(2, 10), key: bytes.subarray(10) };
}

/**
 * A `.minisig` file: an untrusted comment, the signature (prehashed "ED"
 * only), the trusted comment and the signature over both.
 */
export function parseSignatureFile(text: string): Signature {
  const lines = text.split(/\r?\n/u);
  const bytes = Buffer.from((lines[1] ?? "").trim(), "base64");
  if (bytes.length !== 74) throw new Error("not a minisign signature");
  if (bytes.subarray(0, 2).toString("latin1") !== "ED") {
    throw new Error("the signature isn't over the file's BLAKE2b-512 hash");
  }
  const trusted = lines[2] ?? "";
  if (!trusted.startsWith("trusted comment: "))
    throw new Error("the signature has no trusted comment");
  const globalSignature = Buffer.from((lines[3] ?? "").trim(), "base64");
  if (globalSignature.length !== 64) throw new Error("the signature's comment isn't signed");
  return {
    keyId: bytes.subarray(2, 10),
    signature: bytes.subarray(10),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature,
  };
}

/** The hash the release signs, fed as the file streams in. */
export function signedHash(): Hash {
  return createHash("blake2b512");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Throws unless `signatureText` is the pinned key's signature of a file with
 * this BLAKE2b-512 hash, and its signed comment names `fileName`, so another
 * signed release file can't stand in for it.
 */
export function verifyAgentSignature(
  publicKeyLine: string,
  signatureText: string,
  fileHash: Buffer,
  fileName: string,
): void {
  const pinned = parsePublicKey(publicKeyLine);
  const signature = parseSignatureFile(signatureText);
  if (!pinned.keyId.equals(signature.keyId)) {
    throw new Error("the agent was signed with a different key");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pinned.key]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, fileHash, key, signature.signature)) {
    throw new Error("the agent's signature doesn't match the download");
  }
  const comment = Buffer.from(signature.trustedComment, "utf8");
  if (
    !verify(null, Buffer.concat([signature.signature, comment]), key, signature.globalSignature)
  ) {
    throw new Error("the agent's signature comment was changed");
  }
  // The signer may record the path it signed from; the file's name is what counts.
  const named = /(?:^|\t)file:([^\t]+)/u
    .exec(signature.trustedComment)?.[1]
    ?.split(/[\\/]/u)
    .at(-1);
  if (named !== fileName) throw new Error("the signature is for a different file");
}
