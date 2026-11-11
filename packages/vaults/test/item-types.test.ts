import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeItemTypeMarker,
  encodeItemTypeMarker,
  generateSshKeyPair,
  isItemTypeMarkerName,
  looksLikeSshPrivateKey,
  parseCardExpiry,
  sshPublicKeyFingerprint,
  sshPublicKeyFromPrivateKey,
} from "../src";

describe("the opengeni.type marker", () => {
  test("round-trips a type with and without a category", () => {
    for (const marker of [
      { type: "api_key" as const, category: null },
      { type: "api_key" as const, category: "database" },
      { type: "note" as const, category: "health_insurance" },
      { type: "identity" as const, category: "person" },
    ]) {
      expect(decodeItemTypeMarker(encodeItemTypeMarker(marker))).toEqual(marker);
    }
    expect(encodeItemTypeMarker({ type: "api_key", category: "database" })).toBe(
      "api_key/database",
    );
  });

  test("names nothing for unknown types, passkeys, bad categories or extra parts", () => {
    for (const value of [
      null,
      undefined,
      "",
      "secret",
      "passkey",
      "api_key/Not A Token",
      "api_key/database/extra",
    ]) {
      expect(decodeItemTypeMarker(value)).toBeNull();
    }
  });

  test("its field name matches however a provider cases it", () => {
    expect(isItemTypeMarkerName("opengeni.type")).toBe(true);
    expect(isItemTypeMarkerName(" Opengeni.Type ")).toBe(true);
    expect(isItemTypeMarkerName("type")).toBe(false);
  });
});

describe("parseCardExpiry", () => {
  test("reads the usual one-value expiry forms", () => {
    expect(parseCardExpiry("07/2031")).toEqual({ month: "7", year: "2031" });
    expect(parseCardExpiry("7/31")).toEqual({ month: "7", year: "2031" });
    expect(parseCardExpiry("2031-07")).toEqual({ month: "7", year: "2031" });
    expect(parseCardExpiry("203107")).toEqual({ month: "7", year: "2031" });
    expect(parseCardExpiry(" 12 . 2030 ")).toEqual({ month: "12", year: "2030" });
  });

  test("refuses what is no month and year", () => {
    for (const value of ["", "13/2030", "00/30", "July 2031", "2031", "1/2/2031"]) {
      expect(parseCardExpiry(value)).toBeNull();
    }
  });
});

describe("SSH keys", () => {
  test("a generated key pair derives back to the same public key and fingerprint", () => {
    for (const algorithm of ["ed25519", "rsa4096"] as const) {
      const pair = generateSshKeyPair(algorithm, "build@example");
      expect(looksLikeSshPrivateKey(pair.privateKey)).toBe(true);
      expect(pair.publicKey.endsWith(" build@example")).toBe(true);
      expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      const derived = sshPublicKeyFromPrivateKey(pair.privateKey)!;
      expect(derived.publicKey).toBe(pair.publicKey);
      expect(derived.fingerprint).toBe(pair.fingerprint);
      expect(derived.keyType).toBe(algorithm === "ed25519" ? "ssh-ed25519" : "ssh-rsa");
      expect(sshPublicKeyFingerprint(pair.publicKey)).toBe(pair.fingerprint);
    }
  });

  test("text that is no readable private key derives nothing", () => {
    expect(sshPublicKeyFromPrivateKey("not a key")).toBeNull();
    expect(
      sshPublicKeyFromPrivateKey(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toBeNull();
    expect(sshPublicKeyFingerprint("ssh-ed25519 not-base64!")).toBeNull();
    expect(sshPublicKeyFingerprint("ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIA==")).toBeNull();
  });

  const sshKeygen = Bun.which("ssh-keygen");
  test.skipIf(!sshKeygen)("agrees with ssh-keygen on its own keys and on ours", () => {
    const dir = mkdtempSync(join(tmpdir(), "og-ssh-keys-"));
    const run = (...args: string[]) => {
      const result = Bun.spawnSync([sshKeygen!, ...args], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      const cases: Array<[string, string[]]> = [
        ["ed25519", ["-t", "ed25519"]],
        ["rsa", ["-t", "rsa", "-b", "2048"]],
        ["ecdsa", ["-t", "ecdsa", "-b", "256"]],
        ["rsa-pem", ["-t", "rsa", "-b", "2048", "-m", "PEM"]],
      ];
      for (const [name, args] of cases) {
        const file = join(dir, name);
        run(...args, "-N", "", "-C", "", "-q", "-f", file);
        const derived = sshPublicKeyFromPrivateKey(readFileSync(file, "utf8"))!;
        const expected = run("-y", "-f", file).split(" ").slice(0, 2).join(" ");
        expect(derived.publicKey.split(" ").slice(0, 2).join(" ")).toBe(expected);
        expect(derived.fingerprint).toBe(run("-l", "-E", "sha256", "-f", file).split(" ")[1]!);
      }
      const ours = generateSshKeyPair("ed25519");
      const file = join(dir, "ours");
      writeFileSync(file, ours.privateKey, { mode: 0o600 });
      expect(run("-y", "-f", file)).toBe(ours.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
