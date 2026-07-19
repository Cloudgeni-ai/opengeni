import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateAgentUpdateManifest,
  writeAgentUpdateManifest,
} from "./generate-agent-update-manifest";

const ASSETS = [
  "opengeni-agent-x86_64-unknown-linux-musl",
  "opengeni-agent-aarch64-unknown-linux-musl",
  "opengeni-agent-universal-apple-darwin",
  "opengeni-agent-x86_64-pc-windows-msvc.exe",
  "opengeni-agent-aarch64-pc-windows-msvc.exe",
];
const directories: string[] = [];

async function stagedArtifacts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opengeni-agent-manifest-"));
  directories.push(dir);
  await Promise.all(
    ASSETS.flatMap((asset) => {
      const body = `built ${asset}\n`;
      const sha256 = createHash("sha256").update(body).digest("hex");
      return [
        writeFile(join(dir, asset), body),
        writeFile(join(dir, `${asset}.sha256`), `${sha256}  ${asset}\n`),
        writeFile(join(dir, `${asset}.minisig`), "untrusted comment: fixture\nSIGNATURE\n"),
      ];
    }),
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generate-agent-update-manifest", () => {
  test("is deterministic and points stable discovery at immutable signed artifacts", async () => {
    const dir = await stagedArtifacts();
    const options = {
      dir,
      version: "1.2.3",
      signedAtMs: 1_700_000_000_000,
      releaseDownloadBase: "https://github.com/Cloudgeni-ai/opengeni/releases/download/",
    };
    const first = await generateAgentUpdateManifest(options);
    const second = await generateAgentUpdateManifest(options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      channel: "stable",
      version: "1.2.3",
      min_supported: "1.2.3",
      rollout_percent: 100,
      signed_at_ms: 1_700_000_000_000,
    });
    expect(first.artifacts).toHaveLength(5);
    for (const artifact of first.artifacts) {
      expect(artifact.url).toStartWith(
        "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v1.2.3/",
      );
      expect(artifact.url).not.toContain("agent-latest");
      expect(artifact.minisig_url).toBe(`${artifact.url}.minisig`);
    }
    await writeAgentUpdateManifest(join(dir, "manifest.json"), options);
    expect(await Bun.file(join(dir, "manifest.json")).text()).toBe(
      `${JSON.stringify(first, null, 2)}\n`,
    );
  });

  test("refuses an incomplete or tampered release bundle", async () => {
    const dir = await stagedArtifacts();
    await rm(join(dir, `${ASSETS[0]}.minisig`));
    await expect(
      generateAgentUpdateManifest({
        dir,
        version: "1.2.3",
        signedAtMs: 0,
        releaseDownloadBase: "https://github.com/Cloudgeni-ai/opengeni/releases/download",
      }),
    ).rejects.toThrow("missing detached minisign signature");
  });

  test("refuses non-concrete release versions before reading artifacts", async () => {
    await expect(
      generateAgentUpdateManifest({
        dir: "/does/not/matter",
        version: "latest",
        signedAtMs: 0,
        releaseDownloadBase: "https://github.com/Cloudgeni-ai/opengeni/releases/download",
      }),
    ).rejects.toThrow("concrete semantic version");
  });
});
