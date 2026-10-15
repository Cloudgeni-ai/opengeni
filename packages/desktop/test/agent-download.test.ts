import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentAssetName, signedHash, verifyAgentSignature } from "../src/main/agent-download";

/** A minisign key pair and signer, the way the release signs agent files. */
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const publicLine = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const signFile = (bytes: Buffer, comment: string) => {
    const hash = createHash("blake2b512").update(bytes).digest();
    const signature = sign(null, hash, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return [
      "untrusted comment: signature from rsign secret key",
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
  };
  return { publicLine, signFile };
}

const hashOf = (bytes: Buffer) => createHash("blake2b512").update(bytes).digest();

describe("agent download", () => {
  test("picks the release file for each system", () => {
    expect(agentAssetName("darwin", "arm64")).toBe("opengeni-agent-universal-apple-darwin");
    expect(agentAssetName("darwin", "x64")).toBe("opengeni-agent-universal-apple-darwin");
    expect(agentAssetName("linux", "x64")).toBe("opengeni-agent-x86_64-unknown-linux-musl");
    expect(agentAssetName("linux", "arm64")).toBe("opengeni-agent-aarch64-unknown-linux-musl");
    expect(agentAssetName("win32", "x64")).toBe("opengeni-agent-x86_64-pc-windows-msvc.exe");
    expect(agentAssetName("win32", "arm64")).toBe("opengeni-agent-aarch64-pc-windows-msvc.exe");
    expect(agentAssetName("linux", "ia32")).toBeNull();
  });

  test("accepts the pinned key's signature of the named file", () => {
    const { publicLine, signFile } = signer();
    const file = Buffer.from("agent bytes");
    const signature = signFile(file, "timestamp:1\tfile:opengeni-agent-x\tprehashed");
    expect(() =>
      verifyAgentSignature(publicLine, signature, hashOf(file), "opengeni-agent-x"),
    ).not.toThrow();
  });

  test("rejects other bytes, other files, other keys and edited comments", () => {
    const { publicLine, signFile } = signer();
    const file = Buffer.from("agent bytes");
    const signature = signFile(file, "timestamp:1\tfile:opengeni-agent-x\tprehashed");
    expect(() =>
      verifyAgentSignature(publicLine, signature, hashOf(Buffer.from("other")), "opengeni-agent-x"),
    ).toThrow("doesn't match");
    expect(() =>
      verifyAgentSignature(publicLine, signature, hashOf(file), "opengeni-agent-y"),
    ).toThrow("different file");
    expect(() =>
      verifyAgentSignature(signer().publicLine, signature, hashOf(file), "opengeni-agent-x"),
    ).toThrow();
    const edited = signature.replace("file:opengeni-agent-x", "file:opengeni-agent-y");
    expect(() =>
      verifyAgentSignature(publicLine, edited, hashOf(file), "opengeni-agent-y"),
    ).toThrow("comment was changed");
  });

  test("hashes a streamed download the way minisign prehashes it", () => {
    const { publicLine, signFile } = signer();
    const file = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    file.write("agent", 1000);
    const signature = signFile(file, "timestamp:1\tfile:opengeni-agent-x\tprehashed");
    const hash = signedHash();
    for (let at = 0; at < file.length; at += 65_536) hash.update(file.subarray(at, at + 65_536));
    const digest = hash.digest();
    expect(Buffer.from(digest).equals(hashOf(file))).toBe(true);
    expect(() =>
      verifyAgentSignature(publicLine, signature, digest, "opengeni-agent-x"),
    ).not.toThrow();
  });

  test("the app pins the key the agent releases are signed with", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const pinnedFile = readFileSync(
      join(root, "agent/install/opengeni-agent-minisign.pub"),
      "utf8",
    );
    const app = readFileSync(join(root, "apps/desktop/src/main.ts"), "utf8");
    const line = pinnedFile.split("\n")[1]!.trim();
    expect(app).toContain(`agentSigningKey: "${line}"`);
  });

  test("verifies a real release signature format", () => {
    // agent-v0.1.65's signature of opengeni-agent-universal-apple-darwin.
    const signature = [
      "untrusted comment: signature from rsign secret key",
      "RUSaqgF1EVFuco2g7z1W1cbWecJgZjqzrrtnrFQkrJbBCFT1p66D/lYs6SAOnAPENRdLEvx9XMLTkIVkcR12Ow47i1doV8YXcQw=",
      "trusted comment: timestamp:1792060310\tfile:opengeni-agent-universal-apple-darwin\tprehashed",
      "5IGC9VL9+eTXNy3IEW0CT40k+T3EiiTuHannchmphlMWrI752yL6G5omN5LD3ayoNrke7NSoBQ46R2PEUgVnBg==",
    ].join("\n");
    // Without the 383 MB file the payload check fails, but only after the key
    // id matched and the format parsed.
    expect(() =>
      verifyAgentSignature(
        "RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn",
        signature,
        Buffer.alloc(64),
        "opengeni-agent-universal-apple-darwin",
      ),
    ).toThrow("doesn't match the download");
  });
});
