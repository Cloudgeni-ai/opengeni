import { describe, expect, test } from "bun:test";
import {
  deploymentProfiles,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  preflightChecksFor,
  requiredRuntimeEnvVars,
} from "../src/index";

describe("deployment contract", () => {
  test("ships valid built-in profiles", () => {
    for (const profile of Object.values(deploymentProfiles)) {
      expect(parseDeploymentContract(profile).profile).toBe(profile.profile);
    }
  });

  test("requires Kubernetes namespace for Kubernetes runtime", () => {
    expect(() => parseDeploymentContract({
      ...deploymentProfiles["kubernetes-external"],
      runtime: {
        platform: "kubernetes",
        cloud: "generic",
      },
    })).toThrow("Kubernetes deployments require runtime.namespace");
  });

  test("supports existing Postgres and Temporal as external dependencies", () => {
    const contract = deploymentProfiles["azure-existing-services"];

    expect(contract.database.mode).toBe("external");
    expect(contract.database.external?.secretRef?.name).toBe("opengeni-database");
    expect(contract.temporal.mode).toBe("external");
    expect(contract.temporal.external?.secretRef?.name).toBe("opengeni-temporal");
  });

  test("includes conformance checks for Azure managed profile", () => {
    const checks = preflightChecksFor(deploymentProfiles["azure-managed"]).map((check) => check.id);

    expect(checks).toContain("kubernetes-context");
    expect(checks).toContain("postgres-pgvector");
    expect(checks).toContain("temporal-connectivity");
    expect(checks).toContain("nats-pubsub");
    expect(checks).toContain("conformance-session");
  });

  test("models local Kubernetes as Helm with in-cluster dependencies and port-forward conformance", () => {
    const contract = deploymentProfiles["local-kubernetes"];

    expect(contract.runtime.platform).toBe("kubernetes");
    expect(contract.runtime.cloud).toBe("local");
    expect(contract.runtime.namespace).toBe("opengeni-local");
    expect(contract.database.mode).toBe("inCluster");
    expect(contract.temporal.mode).toBe("inCluster");
    expect(contract.nats.mode).toBe("inCluster");
    expect(contract.objectStorage.mode).toBe("inCluster");
    expect(contract.objectStorage.api).toBe("s3-compatible");
    expect(contract.ingress.enabled).toBe(false);
  });

  test("models Azure managed profile with in-cluster Temporal and Azure Blob storage", () => {
    const contract = deploymentProfiles["azure-managed"];

    expect(contract.temporal.mode).toBe("inCluster");
    expect(contract.objectStorage.mode).toBe("managed");
    expect(contract.objectStorage.api).toBe("azure-blob");
    expect(contract.sandbox.backend).toBe("none");
  });

  test("allows Modal with Azure Blob because runtime materializes file resources into the sandbox", () => {
    const contract = parseDeploymentContract({
      ...deploymentProfiles["azure-managed"],
      sandbox: { backend: "modal", preparationProfiles: ["none"], envAllowlist: [] },
    });

    expect(contract.sandbox.backend).toBe("modal");
    expect(contract.objectStorage.api).toBe("azure-blob");
  });

  test("lists runtime environment variables needed by deployment renderers", () => {
    const vars = requiredRuntimeEnvVars(deploymentProfiles["azure-existing-services"]);

    expect(vars).toContain("OPENGENI_DATABASE_URL");
    expect(vars).toContain("OPENGENI_TEMPORAL_HOST");
    expect(vars).toContain("OPENGENI_OBJECT_STORAGE_BACKEND");
    expect(vars).toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
  });

  test("does not require generated in-cluster dependency values from local env", () => {
    const vars = requiredRuntimeEnvVars(deploymentProfiles["self-contained-kubernetes"]);

    expect(vars).not.toContain("OPENGENI_DATABASE_URL");
    expect(vars).not.toContain("OPENGENI_TEMPORAL_HOST");
    expect(vars).not.toContain("OPENGENI_NATS_URL");
    expect(vars).not.toContain("OPENGENI_OBJECT_STORAGE_ENDPOINT");
  });

  test("detects missing runtime environment variables without exposing values", () => {
    const missing = missingRuntimeEnvVars(deploymentProfiles["azure-existing-services"], {
      OPENGENI_DATABASE_URL: "postgres://secret",
      OPENGENI_TEMPORAL_HOST: "temporal:7233",
      OPENGENI_OBJECT_STORAGE_BACKEND: "azure-blob",
    });

    expect(missing).not.toContain("OPENGENI_DATABASE_URL");
    expect(missing).not.toContain("OPENGENI_TEMPORAL_HOST");
    expect(missing).toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
  });
});
