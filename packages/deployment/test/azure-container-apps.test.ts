import { describe, expect, test } from "bun:test";

import {
  DeploymentProfileId,
  RuntimePlatform,
  assertRuntimeArtifactsSupported,
  contractForProfile,
  deploymentProfiles,
  generateRuntimeArtifacts,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  preflightChecksFor,
  requiredRuntimeEnvVars,
  stackPlanFor,
} from "../src/index";

const profile = deploymentProfiles["azure-container-apps"];

describe("Azure Container Apps deployment profile", () => {
  test("uses an explicit native runtime and durable Azure services", () => {
    expect(DeploymentProfileId.options).toContain("azure-container-apps");
    expect(RuntimePlatform.options).toContain("azure-container-apps");
    expect(profile.runtime.platform).toBe("azure-container-apps");
    expect(profile.runtime.cloud).toBe("azure");
    expect(profile.runtime.namespace).toBeUndefined();
    expect(profile.database.mode).toBe("managed");
    expect(profile.database.pgvectorRequired).toBe(true);
    expect(profile.database.managed?.provider).toBe("azure");
    expect(profile.objectStorage.mode).toBe("managed");
    expect(profile.objectStorage.api).toBe("azure-blob");
    expect(profile.temporal.mode).toBe("external");
    expect(profile.nats.mode).toBe("external");
    expect(profile.secrets.mode).toBe("azureKeyVault");
    expect(profile.sandbox.backend).toBe("modal");
    expect(profile.ingress.sseTimeoutSeconds).toBe(240);
    expect(profile.product.accessMode).toBe("configured");
  });

  test("refuses incompatible profile/platform, namespace, and cloud settings", () => {
    expect(() =>
      parseDeploymentContract({
        ...profile,
        runtime: { ...profile.runtime, platform: "kubernetes", namespace: "opengeni" },
      }),
    ).toThrow("explicit runtime platform");
    expect(() =>
      parseDeploymentContract({ ...profile, runtime: { ...profile.runtime, cloud: "generic" } }),
    ).toThrow("runtime.cloud=azure");
    expect(() =>
      parseDeploymentContract({
        ...profile,
        runtime: { ...profile.runtime, namespace: "not-a-namespace" },
      }),
    ).toThrow("does not use runtime.namespace");
    expect(() =>
      parseDeploymentContract({ ...deploymentProfiles["azure-managed"], runtime: profile.runtime }),
    ).toThrow("explicit runtime platform");
  });

  test("refuses unsupported local, unauthenticated, or ingress-disabled ACA serving", () => {
    expect(() =>
      parseDeploymentContract({
        ...profile,
        product: { ...profile.product, accessMode: "local" },
      }),
    ).toThrow("configured or managed product access");
    expect(() =>
      parseDeploymentContract({ ...profile, access: { ...profile.access, mode: "disabled" } }),
    ).toThrow("authenticated access boundary");
    expect(() =>
      parseDeploymentContract({ ...profile, ingress: { ...profile.ingress, enabled: false } }),
    ).toThrow("native HTTPS ingress");
    expect(() =>
      parseDeploymentContract({
        ...profile,
        access: { ...profile.access, mode: "externalGateway" },
        product: {
          ...profile.product,
          accessMode: "managed",
          publicBaseUrl: "https://managed.example.test",
        },
      }),
    ).not.toThrow();
    expect(() => parseDeploymentContract(deploymentProfiles["local-compose"])).not.toThrow();
  });

  test("accepts only the module-supported ACA product and deployment access pairings", () => {
    expect(() =>
      parseDeploymentContract({
        ...profile,
        access: { ...profile.access, mode: "externalGateway" },
      }),
    ).toThrow("configured/sharedKey or managed/externalGateway");
    expect(() =>
      parseDeploymentContract({
        ...profile,
        product: {
          ...profile.product,
          accessMode: "managed",
          publicBaseUrl: "https://managed.example.test",
        },
      }),
    ).toThrow("configured/sharedKey or managed/externalGateway");
    expect(requiredRuntimeEnvVars(profile, {})).toContain("OPENGENI_ACCESS_KEY");
    const managed = parseDeploymentContract({
      ...profile,
      access: { ...profile.access, mode: "externalGateway" },
      product: {
        ...profile.product,
        accessMode: "managed",
        publicBaseUrl: "https://managed.example.test",
      },
    });
    expect(requiredRuntimeEnvVars(managed, {})).toContain("OPENGENI_DELEGATION_SECRET");
    expect(requiredRuntimeEnvVars(managed, {})).not.toContain("OPENGENI_ACCESS_KEY");
    expect(stackPlanFor(managed, "none", {}).verifyCommands.join("\n")).toContain(
      'OPENGENI_CONFORMANCE_PRODUCT_TOKEN="$OPENGENI_TEST_WORKSPACE_API_KEY"',
    );
    expect(stackPlanFor(managed, "none", {}).verifyCommands.join("\n")).toContain(
      "--product-access-mode managed --access-mode externalGateway --check-env",
    );
    expect(stackPlanFor(profile, "none", {}).verifyCommands.join("\n")).toContain(
      "--product-access-mode configured --access-mode sharedKey --check-env",
    );
    const generic = deploymentProfiles["azure-managed"];
    for (const [accessMode, mode] of [
      ["configured", "externalGateway"],
      ["managed", "sharedKey"],
    ] as const) {
      expect(() =>
        parseDeploymentContract({
          ...generic,
          access: { ...generic.access, mode },
          product: {
            ...generic.product,
            accessMode,
            publicBaseUrl: "https://generic.example.test",
          },
        }),
      ).not.toThrow();
    }
  });

  test("refuses fixture dependencies and non-native secret delivery", () => {
    for (const field of ["database", "objectStorage", "temporal", "nats"] as const) {
      expect(() =>
        parseDeploymentContract({ ...profile, [field]: { ...profile[field], mode: "inCluster" } }),
      ).toThrow("Azure Container Apps requires");
    }
    expect(() =>
      parseDeploymentContract({
        ...profile,
        database: { ...profile.database, managed: { provider: "aws" } },
      }),
    ).toThrow("managed Azure PostgreSQL");
    expect(() =>
      parseDeploymentContract({
        ...profile,
        objectStorage: { ...profile.objectStorage, api: "s3-compatible" },
      }),
    ).toThrow("managed Azure Blob");
    expect(() =>
      parseDeploymentContract({ ...profile, secrets: { mode: "kubernetesSecret" } }),
    ).toThrow("managed-identity Azure Key Vault");
    for (const field of ["temporal", "nats"] as const) {
      expect(() =>
        parseDeploymentContract({ ...profile, [field]: { ...profile[field], external: {} } }),
      ).toThrow("endpoint or secret reference");
    }
  });

  test("requires a real remote sandbox without changing other profiles", () => {
    for (const backend of ["none", "docker", "local", "selfhosted"]) {
      expect(() =>
        parseDeploymentContract({ ...profile, sandbox: { ...profile.sandbox, backend } }),
      ).toThrow("real remote sandbox");
    }
    const remote = parseDeploymentContract({
      ...profile,
      sandbox: { ...profile.sandbox, backend: "opensandbox" },
    });
    const remotePlan = stackPlanFor(remote, "none", {});
    expect(remotePlan.platformDependencies).toEqual([]);
    expect(requiredRuntimeEnvVars(remote, {})).toContain("OPENGENI_OPENSANDBOX_BASE_URL");
    expect(deploymentProfiles["azure-managed"].sandbox.backend).toBe("none");
    expect(deploymentProfiles["local-compose"].sandbox.backend).toBe("docker");
  });

  test("has Azure-specific preflight checks without a cluster context", () => {
    const checks = preflightChecksFor(profile);
    const ids = checks.map((check) => check.id);
    expect(ids).toContain("azure-container-apps-context");
    expect(ids).toContain("container-registry");
    expect(checks.find((check) => check.id === "container-registry")?.description).toContain(
      "Default create_acr=false requires anonymously pullable images",
    );
    expect(checks.find((check) => check.id === "container-registry")?.description).toContain(
      "managed-identity pull applies only to the optional ACR created by create_acr=true",
    );
    expect(ids).not.toContain("kubernetes-context");
    expect(checks.find((check) => check.id === "postgres-migrations")?.description).toContain(
      "manual migration/provision job",
    );
    expect(checks.find((check) => check.id === "secret-delivery")?.description).toContain(
      "Key Vault",
    );
    expect(checks.find((check) => check.id === "sandbox-readiness")?.required).toBe(true);
    expect(checks.find((check) => check.id === "ingress-sse")?.description).toContain(
      "native HTTP-route edge",
    );
  });

  test("requires explicit external endpoints, model and active sandbox credentials", () => {
    const required = requiredRuntimeEnvVars(profile, {});
    const missing = missingRuntimeEnvVars(profile, {});
    for (const name of [
      "OPENGENI_DATABASE_URL",
      "OPENGENI_TEMPORAL_HOST",
      "OPENGENI_NATS_URL",
      "OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING",
      "OPENGENI_OPENAI_API_KEY",
      "OPENGENI_MODAL_TOKEN_ID",
      "OPENGENI_MODAL_TOKEN_SECRET",
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    ]) {
      expect(required).toContain(name);
      expect(missing).toContain(name);
    }
    expect(required).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(missing).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(required).not.toContain("TEMPORAL_POSTGRES_PASSWORD");
    expect(required).not.toContain("OPENGENI_OPENSANDBOX_API_KEY");
  });

  test("accepts configured shared-key credentials without an explicit delegation secret", () => {
    const env = {
      OPENGENI_ACCESS_KEY: "fixture-shared-access-key",
      OPENGENI_DATABASE_URL: "postgres://fixture:fixture@postgres.invalid/opengeni",
      OPENGENI_TEMPORAL_HOST: "temporal.invalid:7233",
      OPENGENI_NATS_URL: "nats://nats.invalid:4222",
      OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING:
        "DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=fixture",
      OPENGENI_OPENAI_API_KEY: "fixture-model-key",
      OPENGENI_MODAL_APP_NAME: "fixture-modal-app",
      OPENGENI_MODAL_TOKEN_ID: "fixture-modal-id",
      OPENGENI_MODAL_TOKEN_SECRET: "fixture-modal-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    };
    expect(profile.access.mode).toBe("sharedKey");
    expect(requiredRuntimeEnvVars(profile, env)).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(missingRuntimeEnvVars(profile, env)).toEqual([]);
    expect(stackPlanFor(profile, "none", env).requiredSecretKeys).not.toContain(
      "OPENGENI_DELEGATION_SECRET",
    );
    expect(stackPlanFor(profile, "none", env).notes.join("\n")).toContain(
      "reuses OPENGENI_ACCESS_KEY when OPENGENI_DELEGATION_SECRET is unset",
    );
    expect(missingRuntimeEnvVars(profile, { ...env, OPENGENI_ACCESS_KEY: undefined })).toContain(
      "OPENGENI_ACCESS_KEY",
    );
    expect(
      missingRuntimeEnvVars(profile, { ...env, OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: undefined }),
    ).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  });

  test("preserves an explicitly supplied delegation secret in the ACA secret manifest", () => {
    const env = Object.freeze({ OPENGENI_DELEGATION_SECRET: "fixture-host-delegation-secret" });
    const plan = stackPlanFor(profile, "none", env);
    expect(requiredRuntimeEnvVars(profile, env)).toContain("OPENGENI_DELEGATION_SECRET");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_DELEGATION_SECRET");
    expect(missingRuntimeEnvVars(profile, env)).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(env.OPENGENI_DELEGATION_SECRET).toBe("fixture-host-delegation-secret");
    expect(plan.notes.join("\n")).toContain("Preserve an explicitly supplied delegation secret");
    expect(JSON.stringify(plan)).not.toContain(env.OPENGENI_DELEGATION_SECRET);
  });

  test("accepts Blob account credentials without requiring a connection string", () => {
    const env = {
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "fixtureaccount",
      OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: "fixture-account-key",
      OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT: "https://fixtureaccount.blob.example.test",
    };
    const required = requiredRuntimeEnvVars(profile, env);
    expect(required).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME");
    expect(required).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY");
    expect(required).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT");
    expect(required).not.toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
    const missing = missingRuntimeEnvVars(profile, env);
    expect(missing).not.toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
    expect(missing).not.toContain("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY");
    expect(
      missingRuntimeEnvVars(profile, {
        ...env,
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: undefined,
      }),
    ).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY");
    expect(
      missingRuntimeEnvVars(profile, {
        ...env,
        OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: undefined,
      }),
    ).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME");
    const connectionString = {
      ...env,
      OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING: "fixture-connection-string",
    };
    expect(requiredRuntimeEnvVars(profile, connectionString)).toContain(
      "OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING",
    );
    expect(requiredRuntimeEnvVars(profile, connectionString)).not.toContain(
      "OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY",
    );
  });

  test("preserves non-ACA configured access without a shared key and its required secret", () => {
    const generic = deploymentProfiles["azure-managed"];
    const contract = parseDeploymentContract({
      ...generic,
      product: { ...generic.product, accessMode: "configured" },
      access: { ...generic.access, mode: "externalGateway" },
    });
    expect(requiredRuntimeEnvVars(contract, {})).toContain("OPENGENI_DELEGATION_SECRET");
    expect(missingRuntimeEnvVars(contract, {})).toContain("OPENGENI_DELEGATION_SECRET");
    expect(stackPlanFor(contract, "none", {}).requiredSecretKeys).toContain(
      "OPENGENI_DELEGATION_SECRET",
    );
    expect(
      missingRuntimeEnvVars(contract, { OPENGENI_DELEGATION_SECRET: "fixture-host-secret" }),
    ).not.toContain("OPENGENI_DELEGATION_SECRET");
  });

  test("keeps artifact export activation fail-closed, including truthy aliases", () => {
    for (const name of [
      "OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED",
      "OPENGENI_ARTIFACT_MATERIALIZER_ENABLED",
      "OPENGENI_ARTIFACT_OUTBOX_ENABLED",
      "OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED",
    ]) {
      for (const value of ["true", "1", "Y", " On ", "unknown"]) {
        const env = { [name]: value };
        expect(() => contractForProfile("azure-container-apps", "none", env)).toThrow(
          "compatibility-unverified",
        );
        expect(() => stackPlanFor(profile, "none", env)).toThrow("compatibility-unverified");
        expect(() => missingRuntimeEnvVars(profile, env)).toThrow("compatibility-unverified");
      }
      for (const value of [undefined, "false", "0", "off", "No", " n "]) {
        expect(() => stackPlanFor(profile, "none", { [name]: value })).not.toThrow();
      }
    }
    expect(stackPlanFor(profile, "none", {}).notes.join("\n")).toContain(
      "OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED=false",
    );
    expect(() =>
      requiredRuntimeEnvVars(deploymentProfiles["azure-managed"], {
        OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  test("rejects unsupported overlays, maintenance flow, and sandbox mismatch", () => {
    expect(() => contractForProfile("azure-container-apps", "managed-saas-staging", {})).toThrow(
      "does not support managed SaaS",
    );
    expect(() =>
      stackPlanFor(profile, "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: "0435_skill_chat_confirmation",
      }),
    ).toThrow("fresh bootstrap only");
    expect(() =>
      contractForProfile("azure-container-apps", "none", { OPENGENI_SANDBOX_BACKEND: "none" }),
    ).toThrow("must match");
  });

  test("refuses Helm-only artifact generation with a native-path error", () => {
    expect(() => assertRuntimeArtifactsSupported(profile)).toThrow(
      "does not support azure-container-apps",
    );
    expect(() =>
      generateRuntimeArtifacts(
        profile,
        { helm_set_values: { value: { "api.enabled": "true" } } },
        {},
      ),
    ).toThrow("native runtime settings and Key Vault secret references");
    expect(() =>
      assertRuntimeArtifactsSupported(deploymentProfiles["azure-managed"]),
    ).not.toThrow();
  });

  test("renders native bootstrap, exact migration gate, applications, conformance, and teardown", () => {
    const plan = stackPlanFor(profile, "none", {});
    expect(plan.terraformRoot).toBe("deploy/terraform/azure-container-apps");
    expect(plan.helmValuesFile).toBeNull();
    expect(plan.platformDependencies).toEqual([]);
    expect(plan.prerequisites?.join("\n")).toContain("OPENGENI_ACA_TFVARS_FILE");
    expect(plan.prerequisites?.join("\n")).toContain("Linux/WSL2");
    expect(plan.prerequisites?.join("\n")).toContain("util-linux script with -q -e -c support");
    const allValues = [
      ...plan.creates,
      ...plan.externalDependencies,
      ...plan.deployCommands,
      ...plan.verifyCommands,
      ...plan.destroyCommands,
      ...plan.notes,
      ...(plan.prerequisites ?? []),
    ].join("\n");
    expect(allValues).not.toMatch(/\b(?:helm|kubectl|kubernetes|aks|chart)\b|svc\.cluster\.local/i);
    expect(allValues).not.toContain("docker build");
    expect(allValues.match(/--skip-[a-z-]+/g)).toEqual(["--skip-observability"]);
    expect(plan.creates).toContain("separate always-on control and turn worker applications");
    expect(plan.externalDependencies.join("\n")).toContain("External Temporal");
    expect(plan.externalDependencies.join("\n")).toContain("External NATS");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_NATS_URL");
    const deploy = plan.deployCommands;
    const bootstrap = deploy.findIndex(
      (command) => command.includes("apply") && command.includes("deployment_phase=bootstrap"),
    );
    const migration = deploy.findIndex((command) => command.includes("job start"));
    const applications = deploy.findIndex(
      (command) => command.includes("apply") && command.includes("deployment_phase=apps"),
    );
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(migration).toBeGreaterThan(bootstrap);
    expect(applications).toBeGreaterThan(migration);
    expect(deploy[applications]).toContain("job-execution-name");
    expect(deploy[applications]).toContain("= Succeeded &&");
    expect(deploy[applications]).toContain(
      "migration_completed_revision=${OPENGENI_ACA_MIGRATION_IMAGE",
    );
    expect(deploy.filter((command) => command.includes("job start"))).toHaveLength(1);
    expect(plan.verifyCommands.join("\n")).toContain("--sandbox-backend modal");
    expect(plan.verifyCommands.join("\n")).not.toContain("--sandbox-backend none");
    expect(plan.verifyCommands.join("\n")).toContain("scripts/deployment-aca-observability.ts");
    expect(plan.verifyCommands.join("\n")).toContain(
      '--browser-origin "$OPENGENI_API_BASE_URL" --deny-foreign-browser-origin',
    );
    expect(plan.notes.join("\n")).toContain("neither that skip nor private scrape evidence proves");
    expect(plan.destroyCommands[0]).toContain("plan -destroy");
    expect(plan.deployCommands.join("\n")).toContain(
      'init -reconfigure -backend-config="path=${OPENGENI_ACA_STATE_FILE:',
    );
    expect(plan.prerequisites?.join("\n")).toContain("outside the repository");
    expect(plan.prerequisites?.join("\n")).toContain(
      "Default create_acr=false requires anonymously pullable images and grants no access to an existing registry",
    );
    expect(plan.notes.join("\n")).toContain("assigns no roles on existing registries");
    expect(
      [...plan.deployCommands, ...plan.verifyCommands, ...plan.destroyCommands].join("\n"),
    ).not.toContain("-state=");
    expect(plan.destroyCommands[1]).toContain("destroy -var-file=");
    expect(plan.destroyCommands[1]).toContain("-var-file=");
    expect(plan.verifyCommands.join("\n")).toContain("terminationGracePeriodSeconds >= 120");
    expect(plan.verifyCommands.join("\n")).toContain("minReplicas >= 1");
    expect(plan.deployCommands.join("\n")).not.toContain("-var=deployment_phase=foundation");
    expect(plan.deployCommands.join("\n")).toContain("-var=create_acr=false");
    expect(plan.destroyCommands.join("\n")).toContain("-var=create_acr=false");
  });

  test("requires explicit created-ACR mode and gates bootstrap after foundation and manual imports", () => {
    const plan = stackPlanFor(profile, "none", { OPENGENI_ACA_CREATE_ACR: "true" });
    const commands = plan.deployCommands.join("\n");
    expect(plan.creates).toContain("task-owned Azure Container Registry");
    expect(commands).toContain("-var=create_acr=true -var=deployment_phase=foundation");
    expect(commands.indexOf("-var=deployment_phase=foundation")).toBeLessThan(
      commands.indexOf("OPENGENI_ACA_ACR_IMPORTS_COMPLETED"),
    );
    expect(commands.indexOf("OPENGENI_ACA_ACR_IMPORTS_COMPLETED")).toBeLessThan(
      commands.indexOf("az acr repository show"),
    );
    expect(commands.indexOf("az acr repository show")).toBeLessThan(
      commands.indexOf("-var=deployment_phase=bootstrap"),
    );
    expect(commands).toContain("output -json acr");
    expect(commands).toContain("jsonencode(var.images)");
    expect(commands).toContain("fromjson | [.api, .worker, .web]");
    expect(commands).not.toMatch(/\baz acr (?:import|login|build)\b/);
    expect(plan.destroyCommands.join("\n")).toContain("-var=create_acr=true");
    expect(plan.notes.join("\n")).toContain("Never rerun foundation after bootstrap/apps");
    expect(JSON.stringify(plan)).not.toMatch(/\b(?:helm|kubectl|kubernetes|aks|chart)\b/i);
    for (const value of ["", "TRUE", "1", "yes"]) {
      expect(() => stackPlanFor(profile, "none", { OPENGENI_ACA_CREATE_ACR: value })).toThrow(
        "OPENGENI_ACA_CREATE_ACR must be exactly true or false",
      );
    }
    expect(
      stackPlanFor(profile, "none", { OPENGENI_ACA_CREATE_ACR: "false" }).deployCommands,
    ).toEqual(stackPlanFor(profile, "none", {}).deployCommands);
  });
});
