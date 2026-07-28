import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Helm database upgrade contract", () => {
  test("gates workload replacement on schema, role, and runtime-posture convergence", async () => {
    const values = await source("deploy/helm/opengeni/values.yaml");

    const migrate = values.indexOf("bun run db:migrate");
    const provision = values.indexOf("bun run db:provision-roles");
    const assertPosture = values.indexOf("bun run db:assert-runtime-posture");

    expect(migrate).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(migrate);
    expect(assertPosture).toBeGreaterThan(provision);
    expect(values).toContain("helm.sh/hook: post-install,pre-upgrade");
  });

  test("mounts runtime credentials without exposing migration credentials to workloads", async () => {
    const helpers = await source("deploy/helm/opengeni/templates/_helpers.tpl");
    const migrationJob = await source("deploy/helm/opengeni/templates/migration-job.yaml");
    const apiDeployment = await source("deploy/helm/opengeni/templates/api-deployment.yaml");
    const workerDeployment = await source("deploy/helm/opengeni/templates/worker-deployment.yaml");
    const turnWorkerDeployment = await source(
      "deploy/helm/opengeni/templates/worker-turns-deployment.yaml",
    );

    expect(migrationJob).toContain('name: {{ include "opengeni.secretName" . }}');
    expect(migrationJob).toContain(
      '{{- if ne (include "opengeni.migrationSecretName" .) (include "opengeni.secretName" .) }}',
    );
    expect(migrationJob).toContain('name: {{ include "opengeni.migrationSecretName" . }}');

    for (const workload of [apiDeployment, workerDeployment, turnWorkerDeployment]) {
      expect(workload).toContain('name: {{ include "opengeni.secretName" . }}');
      expect(workload).not.toContain('name: {{ include "opengeni.migrationSecretName" . }}');
    }

    const restrictedRuntime = helpers.indexOf("{{- if .Values.postgres.runtime.existingSecret }}");
    const ownerPassword = helpers.indexOf("- name: OPENGENI_POSTGRES_PASSWORD");
    expect(restrictedRuntime).toBeGreaterThan(-1);
    expect(ownerPassword).toBeGreaterThan(restrictedRuntime);
    expect(helpers.slice(restrictedRuntime, ownerPassword)).toContain(
      "- name: OPENGENI_DATABASE_URL",
    );
  });

  test("ships a non-HA single-node profile with narrow private-edge services", async () => {
    const values = await source("deploy/helm/opengeni/values.single-node.example.yaml");
    const defaults = await source("deploy/helm/opengeni/values.yaml");
    const priorityClasses = await source("deploy/helm/opengeni/templates/priority-classes.yaml");
    const natsEdge = await source(
      "deploy/helm/opengeni/templates/nats-websocket-edge-service.yaml",
    );
    const minioEdge = await source("deploy/helm/opengeni/templates/minio-edge-service.yaml");

    expect(values).toContain("replicaCount: 1");
    expect(values).not.toContain("autoscaling:\n    enabled: true");
    expect(values).toContain("resources: null");
    expect(values).toContain("priorityClasses:\n  enabled: true");
    expect(values).toContain("path: /traffic-readyz");
    expect(values).toContain("OPENGENI_TURN_WORKER_CONCURRENCY_MODE: resource-based");
    expect(values).toContain('OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS: "256"');
    for (const tier of ["presentation", "execution", "control", "durable"]) {
      expect(defaults).toContain(`    ${tier}:`);
    }
    expect(priorityClasses).toContain("$tier");
    expect(priorityClasses).toContain("preemptionPolicy:");
    for (const nodePort of [30080, 30081, 30222, 30443, 30900]) {
      expect(values).toContain(`nodePort: ${nodePort}`);
    }

    expect(natsEdge).toContain("targetPort: websocket");
    expect(natsEdge).not.toContain("targetPort: client");
    expect(natsEdge).not.toContain("targetPort: monitor");
    expect(minioEdge).toContain("targetPort: api");
    expect(minioEdge).not.toContain("targetPort: console");
  });
});
