import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function workflow(name: string): Promise<string> {
  return readFile(resolve(root, ".github/workflows", name), "utf8");
}

describe("release image workflow contract", () => {
  test("candidate builds every physical image and freezes a full-SHA receipt", async () => {
    const candidate = await workflow("release-candidate.yml");

    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(candidate).toContain(identity);
    }
    expect(candidate).toContain("candidate-$SOURCE_SHA");
    expect(candidate).toContain("opengeni-candidate-${SOURCE_SHA}");
    expect(candidate).toContain("evidence/release-candidate.json");
    expect(candidate).toContain("cmp evidence/release-candidate.json");
  });

  test("final release promotes accepted manifests and has no image build boundary", async () => {
    const release = await workflow("release.yml");
    const finalJob = release.slice(release.indexOf("\n  images:\n"));

    expect(finalJob).toContain("Promote exact accepted manifests");
    expect(finalJob).toContain("docker buildx imagetools create");
    expect(finalJob).toContain("--prefer-index=false");
    expect(finalJob).toContain("evidence/release-candidate.json");
    expect(finalJob).toContain("bun scripts/release-bom.ts");
    expect(finalJob).toContain("Verify official images support anonymous pull");
    expect(finalJob).toContain("docker logout ghcr.io");
    expect(finalJob).toContain("docker buildx imagetools inspect");
    expect(finalJob).not.toContain("--method PATCH");
    expect(finalJob).not.toContain("docker/build-push-action");
    expect(finalJob).not.toContain("docker build ");
    expect(finalJob).not.toContain("bake-agent.sh");
  });

  test("ordinary CI builds the same five physical image roles", async () => {
    const ci = await workflow("ci.yml");
    const imagesJob = ci.slice(ci.indexOf("\n  images:\n"));

    for (const identity of [
      "target: api",
      "target: worker",
      "target: web",
      "file: docker/sandbox.Dockerfile",
      "file: agent/crates/opengeni-relay/Dockerfile",
    ]) {
      expect(imagesJob).toContain(identity);
    }
  });
});
