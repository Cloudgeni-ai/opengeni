import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const helmAvailable = spawnSync("helm", ["version", "--short"]).status === 0;
const renderTest = helmAvailable ? test : test.skip;
renderTest(
  "Helm backup is opt-in and requires scoped credentials, state and an exact image",
  () => {
    const chart = resolve(import.meta.dir, "../../deploy/helm/opengeni");
    const render = (args: string[]) =>
      spawnSync("helm", ["template", "demo", chart, ...args], { encoding: "utf8" });
    const base = ["--set", "backup.enabled=true"];
    expect(render(base).status).not.toBe(0);
    expect(
      render([
        ...base,
        "--set",
        "backup.existingSecret=backup",
        "--set",
        "backup.existingClaim=backup",
      ]).status,
    ).not.toBe(0);
    const result = render([
      ...base,
      "--set",
      "backup.existingSecret=backup",
      "--set",
      "backup.existingClaim=backup",
      "--set",
      `backup.image.digest=sha256:${"a".repeat(64)}`,
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const jobs = parseAllDocuments(result.stdout)
      .map((d) => d.toJSON())
      .filter((d) => d?.kind === "CronJob");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const pod = job.spec.jobTemplate.spec.template.spec;
      expect(job.spec.concurrencyPolicy).toBe("Forbid");
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.containers[0].image).toStartWith("ghcr.io/cloudgeni-ai/opengeni-backup:");
      expect(pod.containers[0].image).toEndWith(`@sha256:${"a".repeat(64)}`);
      expect(pod.containers[0].envFrom).toBeUndefined();
      expect(
        pod.volumes.find((v: { name: string }) => v.name === "state").persistentVolumeClaim
          .claimName,
      ).toBe("backup");
    }
    const disabled = render([]);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).not.toContain("name: demo-opengeni-backup-run");
  },
);
