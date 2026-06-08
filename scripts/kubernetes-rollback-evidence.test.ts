import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./kubernetes-rollback-evidence.ts", import.meta.url).pathname;
const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Kubernetes rollback evidence", () => {
  it("passes with digest-pinned conformance after rollback and forward roll", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-rollback-"));
    const rollback = writeJson(dir, "rollback-conformance.json", { ok: true });
    const forward = writeJson(dir, "forward-conformance.json", { ok: true });
    const componentDigests = writeJson(dir, "component-digests.json", {
      previous: {
        api: digestA,
        worker: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        web: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
      current: {
        api: digestB,
        worker: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        web: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    });
    const out = join(dir, "rollback.json");

    const result = runScript(out, rollback, forward, digestA, digestB, ["--component-digests", componentDigests]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks[0].metrics.previousArtifactRestored).toBe(true);
    expect(payload.checks[0].metrics.componentDigestEvidenceValid).toBe(true);
  });

  it("fails when forward-roll conformance failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-rollback-"));
    const rollback = writeJson(dir, "rollback-conformance.json", { ok: true });
    const forward = writeJson(dir, "forward-conformance.json", { ok: false });
    const out = join(dir, "rollback.json");

    const result = runScript(out, rollback, forward, digestA, digestB);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].metrics.forwardRollConformancePassed).toBe(false);
  });
});

function runScript(
  out: string,
  rollback: string,
  forward: string,
  previousDigest: string,
  currentDigest: string,
  extra: string[] = [],
): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [
    scriptPath,
    "--previous-digest", previousDigest,
    "--current-digest", currentDigest,
    "--post-rollback-conformance", rollback,
    "--forward-roll-conformance", forward,
    "--rollback-seconds", "240",
    "--out", out,
    ...extra,
  ], { encoding: "utf8" });
}

function writeJson(dir: string, filename: string, payload: unknown): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}
