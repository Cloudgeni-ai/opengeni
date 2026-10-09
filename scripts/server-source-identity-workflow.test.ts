import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function fields(value: string): Map<string, string> {
  return new Map(
    value
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
}

test("API and worker image source bytes use the same admitted SHA as their immutable OCI revision", () => {
  for (const name of ["ci.yml", "release-candidate.yml"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"),
    );
    const steps = Object.values(workflow.jobs).flatMap((job: any) => job.steps ?? []);
    for (const target of ["api", "worker"]) {
      const builds = steps.filter(
        (step: any) =>
          step.with?.target === target && step.with?.file === "docker/opengeni.Dockerfile",
      );
      expect(builds).toHaveLength(1);
      const build: any = builds[0];
      const identity = fields(build.with["build-args"]).get("OPENGENI_SOURCE_SHA");
      expect(identity).toBeDefined();
      expect(identity).toBe(fields(build.with.labels).get("org.opencontainers.image.revision"));
      expect(identity).toContain(
        name === "release-candidate.yml" ? "inputs.source_sha" : "automation_head_sha",
      );
    }
  }
});

test("source identity is baked root-owned after frozen installation and retained by both server targets", () => {
  const dockerfile = readFileSync(
    new URL("../docker/opengeni.Dockerfile", import.meta.url),
    "utf8",
  );
  const base = dockerfile.split("FROM source-base AS base")[0]!;
  const copy = base.indexOf("COPY --chown=bun:bun . .");
  const marker = base.indexOf("ARG OPENGENI_SOURCE_SHA=development");
  expect(copy).toBeGreaterThan(base.indexOf("bun install --frozen-lockfile"));
  expect(marker).toBeGreaterThan(copy);
  expect(base.slice(copy, marker)).toContain("USER root");
  expect(base.slice(marker)).toContain("install -d -o root -g root -m 0555 /opt/opengeni");
  expect(base.slice(marker)).toContain(
    "printf '%s' \"$OPENGENI_SOURCE_SHA\" > /opt/opengeni/source-sha",
  );
  expect(base.slice(marker)).toContain("chmod 0444 /opt/opengeni/source-sha");
  expect(base.slice(marker)).toContain('test "${#OPENGENI_SOURCE_SHA}" = 40');
  expect(dockerfile).toContain("FROM source-base AS worker");
  expect(dockerfile).toContain("FROM source-base AS artifact-runtime-base");
  expect(dockerfile).toContain("FROM artifact-runtime-base AS api");
});
