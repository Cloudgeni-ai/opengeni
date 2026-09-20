import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const source = readFileSync(
  new URL("../.github/workflows/publish-canary-chart.yml", import.meta.url),
  "utf8",
);
const workflow = parse(source);

describe("manual canary chart publication", () => {
  test("admits only exact protected-main dispatch before source or credentials are consumed", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "read", packages: "write" });
    const steps = workflow.jobs.publish.steps;
    const guard = steps[0].run as string;
    for (const admission of [
      '$GITHUB_EVENT_NAME" == "workflow_dispatch',
      '$GITHUB_REPOSITORY" == "Cloudgeni-ai/opengeni',
      '$GITHUB_REF" == "refs/heads/main',
      '$SOURCE_SHA" =~ ^[0-9a-f]{40}$',
      '$SOURCE_SHA" == "$GITHUB_SHA',
      '$GITHUB_WORKFLOW_SHA" == "$GITHUB_SHA',
      "publish-canary-chart.yml@refs/heads/main",
    ])
      expect(guard).toContain(admission);
    expect(steps[1].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(steps[2].run).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    for (const step of steps) {
      if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  test("reuses canonical packaging and run-scoped versions without stable promotion", () => {
    expect(source).toContain(
      "workflowCanarySequence(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)",
    );
    expect(source).toContain("bun scripts/package-release-chart.ts");
    expect(source).toContain('--app-version "canary-sha-${SOURCE_SHA}"');
    expect(source).not.toContain("kubectl");
    expect(source).not.toContain("helm upgrade");
    expect(source).not.toMatch(/:latest\b|--tag latest/);
    expect(source).not.toContain("NPM_TOKEN");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("only pushes absent references and requires byte/digest readback before a receipt", () => {
    const steps = workflow.jobs.publish.steps;
    const publish = steps.find(
      (step: { name?: string }) => step.name === "Reconcile or publish and verify bytes",
    ).run as string;
    expect(publish).toContain('if [ -z "$before" ]; then\n  helm push');
    expect(publish).toContain('cmp "$archive" ".release/chart-readback/opengeni-${VERSION}.tgz"');
    expect(publish).toContain('[ -z "$before" ] || [ "$before" = "$digest" ]');
    expect(publish.indexOf('cmp "$archive"')).toBeLessThan(
      publish.indexOf("> .release/canary-chart.json"),
    );
    expect(publish).toContain('scope:"chart-only"');
    expect(publish).toContain("bytesSha256:$bytesSha256");
    expect(steps.at(-1).if).toBe("always()");
    expect(steps.at(-1).run).toContain("helm registry logout ghcr.io");
  });
});

describe("canary chart publication shell boundary", () => {
  for (const mode of ["absent", "matching", "different-bytes", "lookup-failure", "digest-drift"]) {
    test(`registry ${mode} produces an honest receipt or fails closed`, async () => {
      const scratch = await mkdtemp(join(tmpdir(), "canary-chart-"));
      try {
        const bin = join(scratch, "bin");
        await mkdir(bin);
        await mkdir(join(scratch, ".release"));
        const version = "1.2.3-canary.1001";
        await writeFile(join(scratch, `.release/opengeni-${version}.tgz`), "exact-chart-bytes");
        await writeFile(
          join(bin, "bun"),
          `#!/bin/bash
set -eu
test "$1" = scripts/resolve-optional-oci-manifest.ts
test "$2" = "ghcr.io/cloudgeni-ai/charts/opengeni/opengeni:$VERSION"
if [ "$MODE" = lookup-failure ]; then exit 1; fi
if [ "$MODE" != absent ] || [ -f published ]; then
  if [ "$MODE" = digest-drift ] && [ -f pulled ]; then printf 'sha256:%064d\\n' 2; else printf 'sha256:%064d\\n' 1; fi
fi
`,
          { mode: 0o755 },
        );
        await writeFile(
          join(bin, "helm"),
          `#!/bin/bash
set -eu
if [ "$1" = push ]; then
  test "$MODE" = absent
  touch published
elif [ "$1" = pull ]; then
  touch pulled
  cp ".release/opengeni-$VERSION.tgz" ".release/chart-readback/opengeni-$VERSION.tgz"
  if [ "$MODE" = different-bytes ]; then printf mismatch > ".release/chart-readback/opengeni-$VERSION.tgz"; fi
else exit 1; fi
`,
          { mode: 0o755 },
        );
        const step = workflow.jobs.publish.steps.find(
          (item: { name?: string }) => item.name === "Reconcile or publish and verify bytes",
        );
        const child = Bun.spawn(["bash", "-c", step.run], {
          cwd: scratch,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            MODE: mode,
            VERSION: version,
            SOURCE_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "1",
            GITHUB_RUN_ATTEMPT: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const receipt = join(scratch, ".release/canary-chart.json");
        if (mode === "absent" || mode === "matching") {
          expect(code).toBe(0);
          const value = JSON.parse(await readFile(receipt, "utf8"));
          expect(value.sourceSha).toBe("a".repeat(40));
          expect(value.scope).toBe("chart-only");
          expect(value.digest).toBe(`sha256:${"1".padStart(64, "0")}`);
          expect(value.bytesSha256).toMatch(/^[a-f0-9]{64}$/);
          expect(await Bun.file(join(scratch, "published")).exists()).toBe(mode === "absent");
        } else {
          expect(code).not.toBe(0);
          expect(await Bun.file(receipt).exists()).toBe(false);
          expect(await Bun.file(join(scratch, "published")).exists()).toBe(false);
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }
});
