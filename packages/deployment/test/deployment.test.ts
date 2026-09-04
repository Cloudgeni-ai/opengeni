import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CODEX_UNCONDITIONAL_LEASING_MAINTENANCE_CUTOVER,
  contractForProfile,
  deploymentProfiles,
  EXTERNAL_BROWSER_PROVIDER_PASSTHROUGH_ENV,
  generateRuntimeArtifacts,
  MODEL_CATALOG_MAINTENANCE_CUTOVER,
  SESSION_INPUT_WAIT_MAINTENANCE_CUTOVER,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  preflightChecksFor,
  requiredRuntimeEnvVars,
  SANDBOX_REQUIRED_ENV,
  SANDBOX_LIFECYCLE_PASSTHROUGH_ENV,
  SANDBOX_SURFACING_PASSTHROUGH_ENV,
  SESSION_SELECTED_SKILL_MAINTENANCE_CUTOVER,
  WORKSPACE_CONTROL_PASSTHROUGH_ENV,
  CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV,
  HOST_MCP_AUTHORITY_SOURCE_ADMISSION_PASSTHROUGH_ENV,
  SLACK_WORKSPACE_ROUTING_PASSTHROUGH_ENV,
  SecretDeliveryMode,
  stackPlanFor,
} from "../src/index";

const testEnvironmentsEncryptionKey = Buffer.alloc(32, 2).toString("base64");
const testImageDigests = {
  OPENGENI_API_IMAGE_DIGEST: `sha256:${"1".repeat(64)}`,
  OPENGENI_WORKER_IMAGE_DIGEST: `sha256:${"2".repeat(64)}`,
  OPENGENI_WEB_IMAGE_DIGEST: `sha256:${"3".repeat(64)}`,
  OPENGENI_MIGRATIONS_IMAGE_DIGEST: `sha256:${"4".repeat(64)}`,
};
const maintenanceImageDigests = {
  ...testImageDigests,
  OPENGENI_MIGRATIONS_IMAGE_DIGEST: testImageDigests.OPENGENI_API_IMAGE_DIGEST,
};

describe("deployment contract", () => {
  test("ships valid built-in profiles", () => {
    for (const profile of Object.values(deploymentProfiles)) {
      expect(parseDeploymentContract(profile).profile).toBe(profile.profile);
    }
  });

  test("requires Kubernetes namespace for Kubernetes runtime", () => {
    expect(() =>
      parseDeploymentContract({
        ...deploymentProfiles["kubernetes-external"],
        runtime: {
          platform: "kubernetes",
          cloud: "generic",
        },
      }),
    ).toThrow("Kubernetes deployments require runtime.namespace");
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

  test("restarts the chart-managed OTEL collector when collector config changes", () => {
    const deployment = readFileSync(
      new URL(
        "../../../deploy/helm/opengeni/templates/otel-collector-deployment.yaml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(deployment).toContain("annotations:");
    expect(deployment).toContain("checksum/config:");
    expect(deployment).toContain("/otel-collector-configmap.yaml");
  });

  test("models local Kubernetes as Helm with in-cluster dependencies and port-forward conformance", () => {
    const contract = deploymentProfiles["local-kubernetes"];
    const plan = stackPlanFor(contract);

    expect(contract.runtime.platform).toBe("kubernetes");
    expect(contract.runtime.cloud).toBe("local");
    expect(contract.runtime.namespace).toBe("opengeni-local");
    expect(contract.database.mode).toBe("inCluster");
    expect(contract.temporal.mode).toBe("inCluster");
    expect(contract.nats.mode).toBe("inCluster");
    expect(contract.objectStorage.mode).toBe("inCluster");
    expect(contract.objectStorage.api).toBe("s3-compatible");
    expect(contract.ingress.enabled).toBe(false);
    expect(plan.helmValuesFile).toBe("deploy/helm/opengeni/values.local-kubernetes.example.yaml");
    expect(plan.deployCommands.some((command) => command.includes("kind load docker-image"))).toBe(
      true,
    );
    expect(
      plan.deployCommands.some((command) => command.includes("opengeni-runtime-local-k8s")),
    ).toBe(true);
  });

  test("models a persistent non-HA single-machine deployment without local image builds", () => {
    const contract = deploymentProfiles["single-node-kubernetes"];
    const plan = stackPlanFor(contract);

    expect(contract.runtime.platform).toBe("kubernetes");
    expect(contract.database.mode).toBe("inCluster");
    expect(contract.temporal.mode).toBe("inCluster");
    expect(contract.nats.mode).toBe("inCluster");
    expect(contract.objectStorage.mode).toBe("inCluster");
    expect(contract.ingress.enabled).toBe(false);
    expect(contract.access.mode).toBe("disabled");
    expect(contract.sandbox.backend).toBe("selfhosted");
    expect(plan.helmValuesFile).toBe("deploy/helm/opengeni/values.single-node.example.yaml");
    expect(plan.creates).toContain(
      "persistent single-node Postgres/Temporal/NATS/Garage services and local volumes",
    );
    expect(plan.deployCommands.filter((command) => command.includes("helm upgrade"))).toHaveLength(
      2,
    );
    expect(plan.deployCommands.some((command) => command.includes("docker build"))).toBe(false);
    expect(plan.deployCommands.join("\n")).not.toContain("OPENGENI_OPENAI_API_KEY");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_ENROLLMENT_SIGNING_SECRET");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED");
    expect(plan.requiredSecretKeys).toContain("opengeni-postgres/POSTGRES_PASSWORD");
    expect(plan.requiredSecretKeys).toContain("opengeni-garage/GARAGE_ACCESS_KEY_ID");
    expect(plan.requiredSecretKeys).toContain("opengeni-garage/GARAGE_SECRET_ACCESS_KEY");
    expect(plan.requiredSecretKeys).toContain("opengeni-garage/GARAGE_RPC_SECRET");
    expect(plan.requiredSecretKeys).toContain("opengeni-garage/garage.toml");
    expect(plan.requiredSecretKeys).toContain(
      "opengeni-runtime/OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    );
    expect(plan.requiredSecretKeys).toContain(
      "opengeni-migrations/OPENGENI_MIGRATIONS_DATABASE_URL",
    );
  });

  test("models Azure managed profile with external Temporal/NATS and Azure Blob storage", () => {
    const contract = deploymentProfiles["azure-managed"];

    expect(contract.temporal.mode).toBe("external");
    expect(contract.temporal.external?.secretRef?.key).toBe("OPENGENI_TEMPORAL_HOST");
    expect(contract.nats.mode).toBe("external");
    expect(contract.nats.external?.secretRef?.key).toBe("OPENGENI_NATS_URL");
    expect(contract.objectStorage.mode).toBe("managed");
    expect(contract.objectStorage.api).toBe("azure-blob");
    expect(contract.access.mode).toBe("sharedKey");
    expect(contract.product.accessMode).toBe("configured");
    expect(contract.product.billingMode).toBe("disabled");
    expect(contract.sandbox.backend).toBe("none");
  });

  test("Azure Terraform models deployment automation Azure control-plane access", () => {
    const variables = readFileSync(
      new URL("../../../deploy/terraform/azure/variables.tf", import.meta.url),
      "utf8",
    );
    const main = readFileSync(
      new URL("../../../deploy/terraform/azure/main.tf", import.meta.url),
      "utf8",
    );
    const outputs = readFileSync(
      new URL("../../../deploy/terraform/azure/outputs.tf", import.meta.url),
      "utf8",
    );

    expect(variables).toContain('variable "aks_admin_principal_ids"');
    expect(main).toContain('resource "azurerm_role_assignment" "aks_admin_principals"');
    expect(main).toContain('role_definition_name = "Azure Kubernetes Service Cluster Admin Role"');
    expect(main).toContain("scope                = azurerm_kubernetes_cluster.this.id");
    expect(outputs).toContain('output "aks_admin_principal_ids"');
    expect(variables).toContain('variable "dns_zone_contributor_assignments"');
    expect(main).toContain('resource "azurerm_role_assignment" "dns_zone_contributors"');
    expect(main).toContain('role_definition_name = "DNS Zone Contributor"');
    expect(main).toContain("/providers/Microsoft.Network/dnsZones/");
    expect(outputs).toContain('output "dns_zone_contributor_assignments"');
  });

  test("Azure Terraform models production observability and availability alerts", () => {
    const variables = readFileSync(
      new URL("../../../deploy/terraform/azure/variables.tf", import.meta.url),
      "utf8",
    );
    const main = readFileSync(
      new URL("../../../deploy/terraform/azure/main.tf", import.meta.url),
      "utf8",
    );
    const outputs = readFileSync(
      new URL("../../../deploy/terraform/azure/outputs.tf", import.meta.url),
      "utf8",
    );

    expect(variables).toContain('variable "observability"');
    expect(variables).toContain("observability.availability_test_url is required");
    expect(variables).toContain(
      "observability.alert_email_receivers must include at least one receiver",
    );
    expect(main).toContain('resource "azurerm_log_analytics_workspace" "observability"');
    expect(main).toContain('resource "azurerm_application_insights" "observability"');
    expect(main).toContain(
      'resource "azurerm_application_insights_standard_web_test" "availability"',
    );
    expect(main).toContain('resource "azurerm_monitor_action_group" "observability"');
    expect(main).toContain('resource "azurerm_monitor_metric_alert" "availability"');
    expect(main).toContain("application_insights_web_test_location_availability_criteria");
    expect(outputs).toContain('output "observability"');
  });

  test("models AWS and GCP managed profiles with native object storage", () => {
    const aws = deploymentProfiles["aws-managed"];
    const gcp = deploymentProfiles["gcp-managed"];

    expect(aws.runtime.cloud).toBe("aws");
    expect(aws.temporal.mode).toBe("external");
    expect(aws.nats.mode).toBe("external");
    expect(aws.objectStorage.mode).toBe("managed");
    expect(aws.objectStorage.api).toBe("aws-s3");
    expect(aws.secrets.mode).toBe("awsSecretsManager");
    expect(aws.access.mode).toBe("sharedKey");
    expect(aws.observability.backend).toBe("awsManaged");

    expect(gcp.runtime.cloud).toBe("gcp");
    expect(gcp.temporal.mode).toBe("external");
    expect(gcp.nats.mode).toBe("external");
    expect(gcp.objectStorage.mode).toBe("managed");
    expect(gcp.objectStorage.api).toBe("gcs");
    expect(gcp.secrets.mode).toBe("gcpSecretManager");
    expect(gcp.access.mode).toBe("sharedKey");
    expect(gcp.observability.backend).toBe("gcpManaged");
  });

  test("requires an access boundary for ingress-enabled deployments", () => {
    expect(() =>
      parseDeploymentContract({
        ...deploymentProfiles["kubernetes-external"],
        access: { mode: "disabled" },
      }),
    ).toThrow("ingress-enabled deployments require shared-key auth or an external gateway");
  });

  test("models PR and branch previews as isolated Kubernetes environments", () => {
    const pr = deploymentProfiles["preview-pr"];
    const branch = deploymentProfiles["preview-branch"];

    expect(pr.runtime.platform).toBe("kubernetes");
    expect(pr.runtime.namespace).toBe("opengeni-preview-pr");
    expect(pr.database.mode).toBe("inCluster");
    expect(pr.objectStorage.api).toBe("s3-compatible");
    expect(pr.secrets.mode).toBe("externalSecrets");
    expect(pr.access.mode).toBe("externalGateway");
    expect(pr.product.accessMode).toBe("managed");
    expect(pr.product.billingMode).toBe("stripe");
    expect(pr.sandbox.backend).toBe("modal");

    expect(branch.runtime.platform).toBe("kubernetes");
    expect(branch.runtime.namespace).toBe("opengeni-preview-branch");
    expect(branch.access.mode).toBe("externalGateway");
    expect(branch.sandbox.backend).toBe("modal");
    expect(stackPlanFor(pr).helmValuesFile).toBe(
      "deploy/helm/opengeni/values.preview-managed.example.yaml",
    );
  });

  test("allows Modal with Azure Blob because runtime materializes file resources into the sandbox", () => {
    const contract = parseDeploymentContract({
      ...deploymentProfiles["azure-managed"],
      sandbox: {
        backend: "modal",
        preparationProfiles: ["none"],
        envAllowlist: [],
      },
    });

    expect(contract.sandbox.backend).toBe("modal");
    expect(contract.objectStorage.api).toBe("azure-blob");
  });

  test("lists runtime environment variables needed by deployment renderers", () => {
    const vars = requiredRuntimeEnvVars(deploymentProfiles["azure-existing-services"]);

    expect(vars).toContain("OPENGENI_DATABASE_URL");
    expect(vars).toContain("OPENGENI_TEMPORAL_HOST");
    expect(vars).toContain("OPENGENI_NATS_URL");
    expect(vars).toContain("OPENGENI_AUTH_REQUIRED");
    expect(vars).toContain("OPENGENI_ACCESS_KEY");
    expect(vars).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(vars).toContain("OPENGENI_PRODUCT_ACCESS_MODE");
    expect(vars).toContain("OPENGENI_OBJECT_STORAGE_BACKEND");
    expect(vars).toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
  });

  test("lists native cloud storage environment variables without static key assumptions", () => {
    const awsVars = requiredRuntimeEnvVars(deploymentProfiles["aws-existing-services"]);
    const gcpVars = requiredRuntimeEnvVars(deploymentProfiles["gcp-existing-services"]);

    expect(awsVars).toContain("OPENGENI_OBJECT_STORAGE_REGION");
    expect(awsVars).not.toContain("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID");
    expect(awsVars).not.toContain("OPENGENI_OBJECT_STORAGE_ENDPOINT");

    expect(gcpVars).toContain("OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID");
    expect(gcpVars).not.toContain("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID");
    expect(gcpVars).not.toContain("OPENGENI_OBJECT_STORAGE_ENDPOINT");
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

  test("renders stack plans with deploy, verify, and destroy commands", () => {
    const plan = stackPlanFor(deploymentProfiles["gcp-managed"]);

    expect(plan.terraformRoot).toBe("deploy/terraform/gcp");
    expect(plan.helmValuesFile).toBe("deploy/helm/opengeni/values.gcp-managed.example.yaml");
    expect(plan.platformDependencies.map((dependency) => dependency.id)).toEqual([
      "nats",
      "temporal",
    ]);
    expect(plan.platformDependencies[0]?.chartName).toBe("nats/nats");
    expect(plan.platformDependencies[1]?.chartName).toBe("temporal/temporal");
    expect(plan.platformDependencies[0]?.runtimeEnv.OPENGENI_NATS_URL).toContain(
      "opengeni-nats.opengeni-platform",
    );
    expect(plan.platformDependencies[1]?.runtimeEnv.OPENGENI_TEMPORAL_HOST).toContain(
      "opengeni-temporal-frontend.opengeni-platform",
    );
    expect(plan.platformDependencies[1]?.requiredEnvVars).toContain("TEMPORAL_POSTGRES_HOST");
    expect(plan.platformDependencies[1]?.requiredEnvVars).toContain("TEMPORAL_POSTGRES_PASSWORD");
    expect(plan.creates).toContain("GKE cluster");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_ACCESS_KEY");
    expect(plan.requiredSecretKeys).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(plan.requiredSecretKeys).toContain("opengeni-temporal-postgres/password");
    expect(plan.deployCommands.some((command) => command.includes("helm repo add nats"))).toBe(
      true,
    );
    expect(plan.deployCommands.some((command) => command.includes("helm repo add temporal"))).toBe(
      true,
    );
    expect(
      plan.deployCommands.some((command) =>
        command.includes("terraform -chdir=deploy/terraform/gcp apply"),
      ),
    ).toBe(true);
    expect(
      plan.deployCommands.some(
        (command) => command.includes("docker build") && command.includes("--target api"),
      ),
    ).toBe(true);
    expect(
      plan.deployCommands.some(
        (command) =>
          command.includes("--target web") &&
          command.includes("--build-arg OPENGENI_DEPLOYMENT_REVISION"),
      ),
    ).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("docker push"))).toBe(true);
    expect(plan.deployCommands.join("\n")).toContain("gcloud artifacts docker images describe");
    expect(plan.deployCommands.join("\n")).toContain(
      ". .agent/generated/gcp-managed/image-digests.env",
    );
    expect(
      plan.deployCommands.some((command) => command.includes("deployment:runtime-artifacts")),
    ).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("opengeni-runtime"))).toBe(true);
    expect(
      plan.deployCommands.filter(
        (command) => command.includes("helm upgrade") && command.includes("deploy/helm/opengeni"),
      ),
    ).toHaveLength(1);
    expect(plan.deployCommands.join("\n")).not.toContain("--set migrations.enabled=false");
    expect(plan.deployCommands.join("\n")).not.toContain("wait --for=delete pod");
    expect(
      plan.deployCommands.some((command) =>
        command.includes(".agent/generated/gcp-managed/helm-values.generated.yaml"),
      ),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) =>
        command.includes("rollout status statefulset/opengeni-nats"),
      ),
    ).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("helm test opengeni-nats"))).toBe(
      true,
    );
    expect(
      plan.verifyCommands.some((command) =>
        command.includes("rollout status deployment/opengeni-temporal-frontend"),
      ),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) => command.includes("helm test opengeni-temporal")),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) =>
        command.includes("OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY"),
      ),
    ).toBe(true);
    expect(
      plan.destroyCommands.some((command) => command.includes("helm uninstall opengeni-temporal")),
    ).toBe(true);
    expect(
      plan.destroyCommands.some((command) => command.includes("helm uninstall opengeni-nats")),
    ).toBe(true);
    expect(plan.destroyCommands.at(-1)).toContain("terraform -chdir=deploy/terraform/gcp destroy");
  });

  test("renders AWS Temporal TLS commands with concrete generated paths", () => {
    const plan = stackPlanFor(deploymentProfiles["aws-managed"]);
    const commands = plan.deployCommands.join("\n");

    expect(commands).toContain(".agent/generated/aws-managed/rds-global-bundle.pem");
    expect(commands).toContain("aws ecr describe-images");
    expect(commands).toContain("OPENGENI_MIGRATIONS_IMAGE_DIGEST=%s");
    expect(commands).not.toContain("${contract.profile}");
  });

  test("renders Azure Temporal Postgres TLS by default", () => {
    const plan = stackPlanFor(deploymentProfiles["azure-managed"]);
    const commands = plan.deployCommands.join("\n");

    expect(commands).toContain(
      'TEMPORAL_POSTGRES_TLS_ENABLED="${TEMPORAL_POSTGRES_TLS_ENABLED:-true}"',
    );
    expect(commands).toContain("az acr repository show");
    expect(commands).not.toContain("opengeni-postgres-ca");
  });

  test("drains applications for every documented maintenance cutover", () => {
    for (const cutover of [
      MODEL_CATALOG_MAINTENANCE_CUTOVER,
      SESSION_SELECTED_SKILL_MAINTENANCE_CUTOVER,
      SESSION_INPUT_WAIT_MAINTENANCE_CUTOVER,
      CODEX_UNCONDITIONAL_LEASING_MAINTENANCE_CUTOVER,
    ]) {
      const plan = stackPlanFor(deploymentProfiles["gcp-managed"], "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: cutover,
        OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED: "true",
      });
      const commands = plan.deployCommands.join("\n");

      expect(
        plan.deployCommands.filter(
          (command) => command.includes("helm upgrade") && command.includes("deploy/helm/opengeni"),
        ),
      ).toHaveLength(2);
      const helmCommands = plan.deployCommands.filter(
        (command) => command.includes("helm upgrade") && command.includes("deploy/helm/opengeni"),
      );
      expect(helmCommands[0]).not.toContain("--atomic");
      expect(helmCommands[1]).toContain("--atomic --cleanup-on-fail");
      expect(commands).toContain("--set migrations.enabled=false");
      expect(commands).toContain("wait --for=delete pod");
      expect(plan.notes.join("\n")).toContain(cutover);
      expect(plan.notes.join("\n")).toContain("applications-disabled revision");
      if (cutover === CODEX_UNCONDITIONAL_LEASING_MAINTENANCE_CUTOVER) {
        expect(plan.notes.join("\n")).toContain("migration 0403");
      }
    }

    const rollingPlan = stackPlanFor(deploymentProfiles["gcp-managed"]);
    expect(rollingPlan.deployCommands.join("\n")).not.toContain("--atomic");

    expect(() =>
      stackPlanFor(deploymentProfiles["gcp-managed"], "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: CODEX_UNCONDITIONAL_LEASING_MAINTENANCE_CUTOVER,
      }),
    ).toThrow("OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED=true");
    expect(() =>
      stackPlanFor(deploymentProfiles["gcp-managed"], "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: "unknown-maintenance-cutover",
      }),
    ).toThrow("unsupported OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER");
  });

  test("pins every non-managed Kubernetes image before a maintenance drain", () => {
    for (const profile of ["single-node-kubernetes", "kubernetes-external"] as const) {
      expect(() =>
        stackPlanFor(deploymentProfiles[profile], "none", {
          OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: MODEL_CATALOG_MAINTENANCE_CUTOVER,
          OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED: "true",
        }),
      ).toThrow("OPENGENI_API_IMAGE_DIGEST must be an exact sha256 digest");

      const plan = stackPlanFor(deploymentProfiles[profile], "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: MODEL_CATALOG_MAINTENANCE_CUTOVER,
        OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED: "true",
        ...maintenanceImageDigests,
      });
      const helmCommands = plan.deployCommands.filter(
        (command) => command.includes("helm upgrade") && command.includes("deploy/helm/opengeni"),
      );
      expect(helmCommands).toHaveLength(2);
      expect(helmCommands[0]).not.toContain("--atomic");
      expect(helmCommands[1]).toContain("--atomic --cleanup-on-fail");
      for (const command of helmCommands) {
        expect(command).toContain(
          `--set-string api.image.digest=${maintenanceImageDigests.OPENGENI_API_IMAGE_DIGEST}`,
        );
        expect(command).toContain(
          `--set-string worker.image.digest=${maintenanceImageDigests.OPENGENI_WORKER_IMAGE_DIGEST}`,
        );
        expect(command).toContain(
          `--set-string web.image.digest=${maintenanceImageDigests.OPENGENI_WEB_IMAGE_DIGEST}`,
        );
        expect(command).toContain(
          `--set-string migrations.image.digest=${maintenanceImageDigests.OPENGENI_MIGRATIONS_IMAGE_DIGEST}`,
        );
      }
    }

    expect(() =>
      stackPlanFor(deploymentProfiles["kubernetes-external"], "none", {
        OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: MODEL_CATALOG_MAINTENANCE_CUTOVER,
        OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED: "true",
        ...testImageDigests,
      }),
    ).toThrow("OPENGENI_MIGRATIONS_IMAGE_DIGEST must equal OPENGENI_API_IMAGE_DIGEST");
  });

  test("binds a local Kubernetes maintenance drain and final upgrade to one built image set", () => {
    const plan = stackPlanFor(deploymentProfiles["local-kubernetes"], "none", {
      OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER: MODEL_CATALOG_MAINTENANCE_CUTOVER,
      OPENGENI_DEPLOYMENT_MAINTENANCE_PREFLIGHT_CONFIRMED: "true",
    });
    const commands = plan.deployCommands.join("\n");
    const helmCommands = plan.deployCommands.filter(
      (command) => command.includes("helm upgrade") && command.includes("deploy/helm/opengeni"),
    );

    expect(commands).toContain("opengeni-api:local-k8s-maintenance-candidate");
    expect(commands).toContain("docker image inspect --format '{{.Id}}'");
    expect(commands).toContain("git hash-object --stdin");
    expect(commands).toContain("maintenance-image-tag.env");
    expect(commands).toContain(
      'kind load docker-image "opengeni-api:$OPENGENI_LOCAL_K8S_IMAGE_TAG"',
    );
    expect(helmCommands).toHaveLength(2);
    for (const command of helmCommands) {
      expect(command).toContain(". .agent/generated/local-kubernetes/maintenance-image-tag.env");
      for (const component of ["api", "worker", "web", "migrations"]) {
        expect(command).toContain(
          `--set-string ${component}.image.tag="$OPENGENI_LOCAL_K8S_IMAGE_TAG"`,
        );
      }
    }
    expect(helmCommands[0]).not.toContain("if ! helm status");
    expect(helmCommands[0]).not.toContain("--atomic");
    expect(helmCommands[1]).toContain("--atomic --cleanup-on-fail");
    expect(commands.indexOf("kind load docker-image")).toBeLessThan(
      commands.indexOf("--set api.enabled=false"),
    );
    expect(commands.indexOf("wait --for=delete pod")).toBeLessThan(
      commands.lastIndexOf("helm upgrade"),
    );
  });

  test("plans pinned private OpenSandbox only when a Kubernetes deployment selects it", () => {
    const contract = withSandboxBackend("opensandbox");
    const plan = stackPlanFor(contract);
    const dependency = plan.platformDependencies.find((entry) => entry.id === "opensandbox");

    expect(dependency).toMatchObject({
      lifecycle: "officialChart",
      namespace: "opensandbox-system",
      releaseName: "opensandbox",
      chartName: "opensandbox-group/OpenSandbox@88004c989e334ffd7811acbe193cddcd9014f14e",
      valuesFile: "deploy/stacks/official-opensandbox.values.yaml",
      runtimeEnv: {
        OPENGENI_OPENSANDBOX_BASE_URL:
          "http://opensandbox-server.opensandbox-system.svc.cluster.local",
      },
    });
    expect(dependency?.requiredSecretKeys).toEqual(["opensandbox-api-key/api-key"]);
    expect(dependency?.installCommands.join("\n")).toContain("prepare-opensandbox-chart.sh");
    expect(dependency?.installCommands.join("\n")).toContain(
      "--post-renderer scripts/operator/opensandbox-image-post-renderer.sh",
    );
    expect(dependency?.installCommands.join("\n")).toContain(
      "create secret generic opensandbox-api-key",
    );
    expect(dependency?.installCommands.join("\n")).toContain(
      "kubectl apply -f deploy/stacks/opensandbox-controller-metrics-service.yaml",
    );
    expect(dependency?.installCommands.join("\n")).toContain(
      "opensandbox-batchsandbox-template.azure.yaml",
    );
    expect(dependency?.installCommands.join("\n")).toContain(
      "ensure-opensandbox-secure-access-secret.sh",
    );
    expect(dependency?.installCommands.join("\n")).toContain(
      "opensandbox-secure-access-runtime-config",
    );
    expect(dependency?.verifyCommands.join("\n")).toContain("opensandbox-ingress-gateway");
    expect(dependency?.notes.join("\n")).toContain("signed endpoints");
    expect(dependency?.verifyCommands.join("\n")).toContain("grep -qx ClusterIP");
    expect(dependency?.verifyCommands.join("\n")).toContain(
      "get svc opensandbox-controller-metrics",
    );
    expect(dependency?.destroyCommands.join("\n")).toContain(
      "delete crd batchsandboxes.sandbox.opensandbox.io",
    );

    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: { value: "x", sensitive: true },
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_OPENSANDBOX_API_KEY: "opensandbox-secret",
        OPENGENI_OPENSANDBOX_IMAGE: `docker.io/opengeni/sandbox@sha256:${"a".repeat(64)}`,
      },
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_OPENSANDBOX_BASE_URL=http://opensandbox-server.opensandbox-system.svc.cluster.local",
    );
    expect(artifacts.missingEnvVars).not.toContain("OPENGENI_OPENSANDBOX_BASE_URL");
  });

  test("uses the generic OpenSandbox template and installs it from local Kubernetes profiles", () => {
    for (const profileId of ["local-kubernetes", "single-node-kubernetes"] as const) {
      const contract = parseDeploymentContract({
        ...deploymentProfiles[profileId],
        sandbox: {
          backend: "opensandbox",
          preparationProfiles: ["none"],
          envAllowlist: [],
        },
      });
      const plan = stackPlanFor(contract);
      const dependency = plan.platformDependencies.find((entry) => entry.id === "opensandbox");
      const installCommands = dependency?.installCommands.join("\n") ?? "";
      const deployCommands = plan.deployCommands.join("\n");

      expect(installCommands).toContain(
        "kubectl apply -f deploy/stacks/opensandbox-batchsandbox-template.yaml",
      );
      expect(installCommands).not.toContain("opensandbox-batchsandbox-template.azure.yaml");
      expect(deployCommands).toContain("prepare-opensandbox-chart.sh");
      expect(deployCommands).toContain("OPENGENI_OPENSANDBOX_API_KEY");
      expect(deployCommands).toContain(
        "config.OPENGENI_OPENSANDBOX_BASE_URL=http://opensandbox-server.opensandbox-system.svc.cluster.local",
      );
      expect(plan.destroyCommands).not.toContain(
        "kubectl delete namespace opengeni-platform --ignore-not-found",
      );
    }

    const genericTemplate = readFileSync(
      new URL("../../../deploy/stacks/opensandbox-batchsandbox-template.yaml", import.meta.url),
      "utf8",
    );
    const azureTemplate = readFileSync(
      new URL(
        "../../../deploy/stacks/opensandbox-batchsandbox-template.azure.yaml",
        import.meta.url,
      ),
      "utf8",
    );
    expect(genericTemplate).not.toContain("nodeSelector:");
    expect(genericTemplate).not.toContain("tolerations:");
    expect(azureTemplate).toContain("opengeni.ai/sandbox-pool: opensandbox");
    expect(azureTemplate).toContain("opengeni.ai/sandbox");
  });

  test("disables upstream native-snapshot controller defaults for the pinned OpenSandbox set", () => {
    const values = readFileSync(
      new URL("../../../deploy/stacks/official-opensandbox.values.yaml", import.meta.url),
      "utf8",
    );
    expect(values).toContain('imageCommitterImage: ""');
    expect(values).toContain('containerdSocketPath: ""');
    expect(values).toContain('commitJobTimeout: ""');
    expect(values).toContain("sandbox_create_timeout_seconds = 900");
    expect(values).toContain("metrics:");
    expect(values).toContain("enabled: true");
    expect(values).toContain("port: 8080");
    expect(values).toContain("secure: false");
    expect(values).not.toContain("sandbox-registry.cn-");
  });

  test("keeps the worker image target reachable by legacy remote Docker builders", () => {
    const dockerfile = readFileSync(
      new URL("../../../docker/opengeni.Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile.indexOf("FROM source-base AS worker")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("FROM source-base AS worker")).toBeLessThan(
      dockerfile.indexOf("FROM source-base AS artifact-runtime-base"),
    );
  });

  test("prepares the declared non-root sandbox workspace in every runtime image", () => {
    const dockerfile = readFileSync(
      new URL("../../../docker/opengeni.Dockerfile", import.meta.url),
      "utf8",
    );
    const workspaceSetup = "RUN install -d -o bun -g bun -m 0755 /workspace";

    expect(dockerfile).toContain(workspaceSetup);
    expect(dockerfile.indexOf(workspaceSetup)).toBeLessThan(
      dockerfile.indexOf("FROM source-base AS worker"),
    );
  });

  test("keeps OpenSandbox absent from default and non-Kubernetes stack plans", () => {
    for (const profile of Object.values(deploymentProfiles)) {
      if (profile.sandbox.backend === "opensandbox") continue;
      expect(
        stackPlanFor(profile).platformDependencies.some((entry) => entry.id === "opensandbox"),
      ).toBe(false);
    }

    const nonKubernetes = parseDeploymentContract({
      ...deploymentProfiles["local-compose"],
      sandbox: {
        backend: "opensandbox",
        preparationProfiles: ["none"],
        envAllowlist: [],
      },
    });
    expect(stackPlanFor(nonKubernetes).platformDependencies).toEqual([]);
  });

  test("does not plan cloud substrate for existing-service profiles", () => {
    const plan = stackPlanFor(deploymentProfiles["aws-existing-services"]);

    expect(plan.terraformRoot).toBeNull();
    expect(plan.platformDependencies).toEqual([]);
    expect(plan.externalDependencies).toContain(
      "Postgres with pgvector reachable through OPENGENI_DATABASE_URL",
    );
    expect(plan.destroyCommands.some((command) => command.includes("terraform"))).toBe(false);
  });

  test("generates private runtime artifacts from GCP Terraform outputs without hand-editing Helm paths", () => {
    const artifacts = generateRuntimeArtifacts(
      deploymentProfiles["gcp-managed"],
      {
        project_id: { value: "opengeni-example" },
        region: { value: "us-central1" },
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        temporal_namespace: { value: "default" },
        temporal_task_queue: { value: "opengeni-runs-ts" },
        object_storage_bucket: { value: "opengeni-example-files" },
        helm_set_values: {
          value: {
            "global.imageRegistry": "us-central1-docker.pkg.dev/opengeni-example/opengeni",
            "serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account":
              "opengeni-runtime@opengeni-example.iam.gserviceaccount.com",
            "config.OPENGENI_OBJECT_STORAGE_BUCKET": "opengeni-example-files",
          },
        },
      },
      {
        OPENGENI_ACCESS_KEY: "test-access-key",
        OPENGENI_DELEGATION_SECRET: "test-delegation-secret",
        OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
        OPENGENI_IMAGE_TAG: "test-sha",
        ...testImageDigests,
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
        OPENGENI_MODEL_COST_POLICY_JSON:
          '{"openrouter/nvidia/nemotron-3-super-120b-a12b:free":"free"}',
        OPENGENI_MODEL_NOTES_JSON:
          '{"openrouter/nvidia/nemotron-3-super-120b-a12b:free":"Starter model."}',
        OPENGENI_OPENAI_API_KEY: "openai",
        OPENGENI_OPENROUTER_API_KEY: "openrouter",
        OPENGENI_TEMPORAL_API_KEY: "temporal-api-key",
        OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64: "cm9v\ndC1jYQ==",
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.helmValuesYaml).toContain(
      'imageRegistry: "us-central1-docker.pkg.dev/opengeni-example/opengeni"',
    );
    expect(artifacts.helmValuesYaml).toContain('tag: "test-sha"');
    expect(artifacts.helmValuesYaml).toContain('OPENGENI_DEPLOYMENT_REVISION: "test-sha"');
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${testImageDigests.OPENGENI_API_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      'iam.gke.io/gcp-service-account: "opengeni-runtime@opengeni-example.iam.gserviceaccount.com"',
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_OBJECT_STORAGE_BACKEND=gcs");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PRODUCT_ACCESS_MODE=configured");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_DEPLOYMENT_REVISION=test-sha");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODEL_CATALOG_SOURCE=database");
    expect(artifacts.runtimeEnv).toContain(
      'OPENGENI_MODEL_COST_POLICY_JSON={"openrouter/nvidia/nemotron-3-super-120b-a12b:free":"free"}',
    );
    expect(artifacts.runtimeEnv).toContain(
      'OPENGENI_MODEL_NOTES_JSON={"openrouter/nvidia/nemotron-3-super-120b-a12b:free":"Starter model."}',
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_OPENROUTER_API_KEY=openrouter");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_TEMPORAL_TLS_ENABLED=false");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_TEMPORAL_API_KEY=temporal-api-key");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64=cm9vdC1jYQ==",
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID=opengeni-example",
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_NATS_URL=nats://opengeni-nats.opengeni-platform.svc.cluster.local:4222",
    );
    expect(artifacts.summary.secretNames).toContain("opengeni-runtime");
  });

  test("uses sensitive Azure Terraform connection string only in private runtime env", () => {
    const artifacts = generateRuntimeArtifacts(
      deploymentProfiles["azure-managed"],
      {
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        temporal_namespace: { value: "default" },
        temporal_task_queue: { value: "opengeni-runs-ts" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: {
          value: {
            "global.imageRegistry": "opengeni.azurecr.io",
            "config.OPENGENI_OBJECT_STORAGE_BACKEND": "azure-blob",
          },
        },
      },
      {
        OPENGENI_ACCESS_KEY: "test-access-key",
        OPENGENI_DELEGATION_SECRET: "test-delegation-secret",
        OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
        OPENGENI_OPENAI_API_KEY: "openai",
        ...testImageDigests,
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.sensitiveTerraformOutputsUsed).toEqual([
      "object_storage_azure_connection_string",
    ]);
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
    );
    expect(artifacts.helmValuesYaml).not.toContain("AccountKey=secret");
  });

  test("renders managed SaaS product posture without conflating it with the Azure infrastructure profile", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging");
    const vars = requiredRuntimeEnvVars(contract);
    const plan = stackPlanFor(contract, "managed-saas-staging");

    expect(contract.access.mode).toBe("externalGateway");
    expect(vars).not.toContain("OPENGENI_ACCESS_KEY");
    expect(vars).toContain("OPENGENI_BETTER_AUTH_SECRET");
    expect(vars).toContain("OPENGENI_STRIPE_WEBHOOK_SECRET");
    expect(vars).toContain("OPENGENI_STRIPE_CREDITS_PRODUCT_ID");
    expect(vars).toContain("OPENGENI_MODEL_PRICING_JSON");
    expect(vars).toContain("OPENGENI_MODAL_TOKEN_SECRET");
    expect(vars).not.toContain("OPENGENI_STATIC_USAGE_LIMITS_JSON");
    expect(
      plan.deployCommands.some((command) =>
        command.includes("--product-overlay managed-saas-staging"),
      ),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) => command.includes("OPENGENI_CONFORMANCE_PRODUCT_TOKEN")),
    ).toBe(true);

    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_BETTER_AUTH_SECRET: "better-auth",
        OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID: "google-login-staging",
        OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_SECRET: "google-login-secret",
        OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID: "github-login-staging",
        OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_SECRET: "github-login-secret",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
        OPENGENI_INTEGRATIONS_ENABLED: "true",
        OPENGENI_INTEGRATIONS_STATE_SECRET: "integration-state",
        OPENGENI_SLACK_CLIENT_ID: "slack-staging-client",
        OPENGENI_SLACK_CLIENT_SECRET: "slack-staging-secret",
        OPENGENI_SLACK_SIGNING_SECRET: "slack-staging-signing-secret",
        OPENGENI_SLACK_BOT_DISPLAY_NAME: "OpenGeni Staging",
        OPENGENI_SLACK_COMMAND: "/opengeni-staging",
        OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED: "true",
        OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID: "github-personal-staging",
        OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET: "github-personal-secret",
        OPENGENI_RESEND_API_KEY: "resend",
        OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
        OPENGENI_GITHUB_APP_ID: "1",
        OPENGENI_GITHUB_CLIENT_ID: "github-client",
        OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
        OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
        OPENGENI_GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
        OPENGENI_STRIPE_SECRET_KEY: "sk_test",
        OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
        OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
        OPENGENI_STRIPE_CREDITS_PRODUCT_ID: "prod_test_credits",
        OPENGENI_MODEL_PRICING_JSON:
          '{"gpt-5.6-sol":{"inputMicrosPerMillionTokens":5000000,"cachedInputMicrosPerMillionTokens":500000,"outputMicrosPerMillionTokens":30000000,"marginBps":2500}}',
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_BASE_URL:
          "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
        OPENGENI_IMAGE_TAG: "release-1",
        ...testImageDigests,
        OPENGENI_MODAL_APP_NAME: "opengeni-staging",
        OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
        OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
        OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_AUTH_REQUIRED=false");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_MANAGED_AUTH_GOOGLE_CLIENT_ID=google-login-staging",
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_MANAGED_AUTH_GITHUB_CLIENT_ID=github-login-staging",
    );
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PRODUCT_ACCESS_MODE=managed");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_PUBLIC_BASE_URL=https://staging.app.opengeni.ai",
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_BILLING_MODE=stripe");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SLACK_CLIENT_ID=slack-staging-client");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SLACK_CLIENT_SECRET=slack-staging-secret");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_SLACK_SIGNING_SECRET=slack-staging-signing-secret",
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SLACK_BOT_DISPLAY_NAME=OpenGeni Staging");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SLACK_COMMAND=/opengeni-staging");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED=true");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID=github-personal-staging",
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET=github-personal-secret",
    );
    expect(artifacts.helmValuesYaml).toContain('tag: "release-1"');
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${testImageDigests.OPENGENI_API_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${testImageDigests.OPENGENI_WORKER_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${testImageDigests.OPENGENI_WEB_IMAGE_DIGEST}"`,
    );
  });

  test("renders production managed SaaS posture without deployment shared key", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-production");
    const vars = requiredRuntimeEnvVars(contract);
    const plan = stackPlanFor(contract, "managed-saas-production");

    expect(contract.product.publicBaseUrl).toBe("https://app.opengeni.ai");
    expect(contract.access.mode).toBe("externalGateway");
    expect(contract.product.accessMode).toBe("managed");
    expect(contract.product.billingMode).toBe("stripe");
    expect(contract.product.entitlementsMode).toBe("managed");
    expect(contract.product.usageLimitsMode).toBe("managed");
    expect(contract.sandbox.backend).toBe("modal");
    expect(vars).not.toContain("OPENGENI_ACCESS_KEY");
    expect(vars).toContain("OPENGENI_BETTER_AUTH_SECRET");
    expect(vars).toContain("OPENGENI_STRIPE_WEBHOOK_SECRET");
    expect(
      plan.deployCommands.some((command) =>
        command.includes("--product-overlay managed-saas-production"),
      ),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) => command.includes("--base-url https://app.opengeni.ai")),
    ).toBe(true);
    expect(
      plan.verifyCommands.some((command) => command.includes("OPENGENI_CONFORMANCE_PRODUCT_TOKEN")),
    ).toBe(true);

    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_BETTER_AUTH_SECRET: "better-auth",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
        OPENGENI_RESEND_API_KEY: "resend",
        OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
        OPENGENI_GITHUB_APP_ID: "3971118",
        OPENGENI_GITHUB_CLIENT_ID: "prod-client",
        OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
        OPENGENI_GITHUB_APP_SLUG: "opengeni-ai",
        OPENGENI_GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
        OPENGENI_STRIPE_SECRET_KEY: "sk_test",
        OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
        OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
        OPENGENI_STRIPE_CREDITS_PRODUCT_ID: "prod_test_credits",
        OPENGENI_MODEL_PRICING_JSON:
          '{"gpt-5.6-sol":{"inputMicrosPerMillionTokens":5000000,"cachedInputMicrosPerMillionTokens":500000,"outputMicrosPerMillionTokens":30000000,"marginBps":2500}}',
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
        OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
        OPENGENI_ANALYTICS_ENABLED: "true",
        OPENGENI_ANALYTICS_CONSENT_REQUIRED: "true",
        OPENGENI_ANALYTICS_REO_CLIENT_ID: "reo_client-1",
        OPENGENI_IMAGE_TAG: "release-prod",
        ...maintenanceImageDigests,
        OPENGENI_MODAL_APP_NAME: "opengeni-prod",
        OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
        OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
        OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_AUTH_REQUIRED=false");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PUBLIC_BASE_URL=https://app.opengeni.ai");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS=https://app.opengeni.ai",
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_EMAIL_FROM=OpenGeni <auth@mail.opengeni.ai>");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_GITHUB_APP_SLUG=opengeni-ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_BILLING_MODE=stripe");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_ANALYTICS_ENABLED=true");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_ANALYTICS_REO_CLIENT_ID=reo_client-1");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_STRIPE_SECRET_KEY=sk_test");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_STRIPE_CREDITS_PRODUCT_ID=prod_test_credits");
    expect(artifacts.helmValuesYaml).toContain('OPENGENI_WEB_ALLOWED_HOSTS: "app.opengeni.ai"');
    expect(artifacts.helmValuesYaml).toContain('OPENGENI_ANALYTICS_ENABLED: "true"');
    expect(artifacts.helmValuesYaml).toContain('OPENGENI_ANALYTICS_REO_CLIENT_ID: "reo_client-1"');
    expect(artifacts.helmValuesYaml).toContain('tag: "release-prod"');
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${maintenanceImageDigests.OPENGENI_API_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${maintenanceImageDigests.OPENGENI_WORKER_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${maintenanceImageDigests.OPENGENI_WEB_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${maintenanceImageDigests.OPENGENI_MIGRATIONS_IMAGE_DIGEST}"`,
    );
  });

  test("does not require legacy Azure api-version for Azure OpenAI v1 base URLs", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging");

    expect(
      requiredRuntimeEnvVars(contract, {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
      }),
    ).not.toContain("OPENGENI_AZURE_OPENAI_API_VERSION");
    expect(
      requiredRuntimeEnvVars(contract, {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL:
          "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
      }),
    ).toContain("OPENGENI_AZURE_OPENAI_API_VERSION");

    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_BETTER_AUTH_SECRET: "better-auth",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
        OPENGENI_RESEND_API_KEY: "resend",
        OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
        OPENGENI_GITHUB_APP_ID: "1",
        OPENGENI_GITHUB_CLIENT_ID: "github-client",
        OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
        OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
        OPENGENI_GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
        OPENGENI_STRIPE_SECRET_KEY: "sk_test",
        OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
        OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
        OPENGENI_STRIPE_CREDITS_PRODUCT_ID: "prod_test_credits",
        OPENGENI_MODEL_PRICING_JSON:
          '{"gpt-5.6-sol":{"inputMicrosPerMillionTokens":5000000,"cachedInputMicrosPerMillionTokens":500000,"outputMicrosPerMillionTokens":30000000,"marginBps":2500}}',
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
        OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
        OPENGENI_IMAGE_TAG: "release-1",
        ...testImageDigests,
        OPENGENI_MODAL_APP_NAME: "opengeni-staging",
        OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
        OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
        OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_AZURE_OPENAI_BASE_URL=https://example.openai.azure.com/openai/v1/",
    );
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_AZURE_OPENAI_API_VERSION=");
  });

  test("requires separate personal GitHub OAuth secrets only when explicitly enabled", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging");
    const disabled = requiredRuntimeEnvVars(contract, {
      OPENGENI_OPENAI_PROVIDER: "openai",
    });
    expect(disabled).not.toContain("OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID");
    expect(disabled).not.toContain("OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET");

    const enabled = requiredRuntimeEnvVars(contract, {
      OPENGENI_OPENAI_PROVIDER: "openai",
      OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED: "true",
    });
    expect(enabled).toEqual(
      expect.arrayContaining([
        "OPENGENI_INTEGRATIONS_ENABLED",
        "OPENGENI_INTEGRATIONS_STATE_SECRET",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID",
        "OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET",
      ]),
    );
  });

  test("generates preview runtime artifacts with a restricted DB identity", () => {
    const contract = contractForProfile("preview-pr");
    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_DATABASE_URL:
          "postgres://opengeni_app:runtime-password@opengeni-preview-postgres:5432/opengeni",
        OPENGENI_PUBLIC_BASE_URL: "https://preview-123.app.opengeni.ai",
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_BETTER_AUTH_SECRET: "better-auth",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
        OPENGENI_RESEND_API_KEY: "resend",
        OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
        OPENGENI_GITHUB_APP_ID: "1",
        OPENGENI_GITHUB_CLIENT_ID: "github-client",
        OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
        OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
        OPENGENI_GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
        OPENGENI_STRIPE_SECRET_KEY: "sk_test",
        OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
        OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
        OPENGENI_STRIPE_CREDITS_PRODUCT_ID: "prod_test_credits",
        OPENGENI_MODEL_PRICING_JSON:
          '{"gpt-5.6-sol":{"inputMicrosPerMillionTokens":5000000,"cachedInputMicrosPerMillionTokens":500000,"outputMicrosPerMillionTokens":30000000,"marginBps":2500}}',
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_BASE_URL:
          "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
        OPENGENI_MODAL_APP_NAME: "opengeni-preview",
        OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
        OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
        OPENGENI_MODAL_TIMEOUT_SECONDS: "300",
        OPENGENI_MODAL_IMAGE_REF: "opengenistgneuacr.azurecr.io/opengeni-desktop:preview-123",
        OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED: "true",
        OPENGENI_STREAM_TOKEN_SECRET: "ogs_preview_stream_secret",
        OPENGENI_IMAGE_TAG: "preview-123",
        ...testImageDigests,
      },
    );

    expect(artifacts.missingEnvVars).toEqual([]);
    // The sandbox workspace HMAC secret is NEVER required (graceful-degrade /
    // delegation-secret fallback) — it must not enter missingEnvVars.
    expect(artifacts.missingEnvVars).not.toContain("OPENGENI_STREAM_TOKEN_SECRET");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_DATABASE_URL=postgres://opengeni_app:runtime-password@opengeni-preview-postgres:5432/opengeni",
    );
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_OBJECT_STORAGE_ENDPOINT=");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_PUBLIC_BASE_URL=https://preview-123.app.opengeni.ai",
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SANDBOX_BACKEND=modal");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=true");
    // Recognized sandbox workspace passthroughs reach the runtime secret when set.
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_STREAM_TOKEN_SECRET=ogs_preview_stream_secret",
    );
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_MODAL_IMAGE_REF=opengenistgneuacr.azurecr.io/opengeni-desktop:preview-123",
    );
    expect(artifacts.helmValuesYaml).toContain(
      'publicEndpoint: "https://preview-123.app.opengeni.ai"',
    );
    expect(artifacts.helmValuesYaml).toContain(
      'OPENGENI_WEB_ALLOWED_HOSTS: "preview-123.app.opengeni.ai"',
    );
    expect(artifacts.helmValuesYaml).toContain('tag: "preview-123"');
    expect(artifacts.helmValuesYaml).toContain(
      `digest: "${testImageDigests.OPENGENI_WORKER_IMAGE_DIGEST}"`,
    );
    expect(artifacts.helmValuesYaml).toContain('OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED: "true"');
    expect(artifacts.helmValuesYaml).toContain('existingSecret: "opengeni-migrations"');
    expect(artifacts.helmValuesYaml).toContain('existingSecret: "opengeni-runtime"');
  });

  test("escapes multiline runtime env values for kubectl env-file secrets", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging", {
      OPENGENI_STAGING_FINAL_BASE_URL: "https://staging.app.opengeni.ai",
    });
    const artifacts = generateRuntimeArtifacts(
      contract,
      {
        acr_login_server: { value: "opengeni.azurecr.io" },
        database_url: { value: "postgres://app:secret@example/opengeni" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: { value: {} },
      },
      {
        OPENGENI_DELEGATION_SECRET: "delegation",
        OPENGENI_BETTER_AUTH_SECRET: "better-auth",
        OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS: "https://staging.app.opengeni.ai",
        OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
        OPENGENI_RESEND_API_KEY: "resend",
        OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "github-state",
        OPENGENI_GITHUB_APP_MANIFEST_BASE_URL: "https://staging.app.opengeni.ai",
        OPENGENI_GITHUB_APP_ID: "1",
        OPENGENI_GITHUB_CLIENT_ID: "github-client",
        OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
        OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
        OPENGENI_GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        OPENGENI_STRIPE_SECRET_KEY: "sk_test",
        OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
        OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
        OPENGENI_MODEL_PRICING_JSON:
          '{"gpt-5.6-sol":{"inputMicrosPerMillionTokens":5000000,"cachedInputMicrosPerMillionTokens":500000,"outputMicrosPerMillionTokens":30000000,"marginBps":2500}}',
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_BASE_URL:
          "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-sol",
        OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
        OPENGENI_MODAL_APP_NAME: "opengeni-staging",
        OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
        OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
        OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      },
    );

    const privateKeyLines = artifacts.runtimeEnv
      .split("\n")
      .filter((line) => line.startsWith("OPENGENI_GITHUB_APP_PRIVATE_KEY="));
    expect(privateKeyLines).toHaveLength(1);
    expect(privateKeyLines[0]).toContain(
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    );
    expect(artifacts.runtimeEnv.split("\n").some((line) => line === "test")).toBe(false);
  });

  test("reports missing required runtime secrets without fabricating values", () => {
    const artifacts = generateRuntimeArtifacts(
      deploymentProfiles["aws-managed"],
      {
        region: { value: "us-east-1" },
        temporal_host: {
          value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233",
        },
        object_storage_bucket: { value: "opengeni-files" },
        helm_set_values: { value: {} },
      },
      {},
    );

    expect(artifacts.missingEnvVars).toContain("OPENGENI_ACCESS_KEY");
    expect(artifacts.missingEnvVars).not.toContain("OPENGENI_DELEGATION_SECRET");
    expect(artifacts.missingEnvVars).toContain("OPENGENI_DATABASE_URL");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_DATABASE_URL=");
  });

  // --- backend-gated sandbox env render (SANDBOX_REQUIRED_ENV, two sites) ---

  function withSandboxBackend(backend: string) {
    return parseDeploymentContract({
      ...deploymentProfiles["azure-managed"],
      sandbox: { backend, preparationProfiles: ["none"], envAllowlist: [] },
    });
  }

  test("SANDBOX_REQUIRED_ENV table is the single source for both required-env and render", () => {
    // The deployment table's `required` set must equal config's required-cred
    // env (parity is the contract). Asserted here for the providers config gates.
    expect(SANDBOX_REQUIRED_ENV.modal.required).toEqual([
      "OPENGENI_MODAL_APP_NAME",
      "OPENGENI_MODAL_TOKEN_ID",
      "OPENGENI_MODAL_TOKEN_SECRET",
      "OPENGENI_MODAL_TIMEOUT_SECONDS",
    ]);
    expect(SANDBOX_REQUIRED_ENV.modal.optional).toEqual(
      expect.arrayContaining([
        "OPENGENI_MODAL_IMAGE_REGISTRY_SECRET",
        "OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS",
        "OPENGENI_MODAL_SANDBOX_CPU",
        "OPENGENI_MODAL_SANDBOX_MEMORY_MIB",
        "OPENGENI_MODAL_WORKSPACE_PERSISTENCE",
        "OPENGENI_SANDBOX_ROTATION_LEAD_MS",
        "OPENGENI_SANDBOX_ROTATION_BATCH_SIZE",
      ]),
    );
    expect(SANDBOX_LIFECYCLE_PASSTHROUGH_ENV).toEqual(
      expect.arrayContaining([
        "OPENGENI_SANDBOX_IDLE_GRACE_MS",
        "OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS",
        "OPENGENI_SANDBOX_SNAPSHOT_INTERVAL_MS",
        "OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS",
        "OPENGENI_SANDBOX_DRAIN_SNAPSHOT_TIMEOUT_MS",
        "OPENGENI_SANDBOX_WARMING_TIMEOUT_MS",
      ]),
    );
    expect(SANDBOX_SURFACING_PASSTHROUGH_ENV).toEqual(
      expect.arrayContaining([
        "OPENGENI_SANDBOX_OWNERSHIP_ENABLED",
        "OPENGENI_SANDBOX_LAZY_PROVISION",
        "OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED",
      ]),
    );
    expect(WORKSPACE_CONTROL_PASSTHROUGH_ENV).toEqual([
      "OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS",
    ]);
    expect(CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV).toEqual([
      "OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED",
    ]);
    expect(HOST_MCP_AUTHORITY_SOURCE_ADMISSION_PASSTHROUGH_ENV).toEqual([
      "OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED",
    ]);
    expect(SLACK_WORKSPACE_ROUTING_PASSTHROUGH_ENV).toEqual([
      "OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED",
    ]);
    expect(EXTERNAL_BROWSER_PROVIDER_PASSTHROUGH_ENV).toEqual([
      "OPENGENI_BROWSERBASE_API_KEY",
      "OPENGENI_KERNEL_API_KEY",
      "OPENGENI_KERNEL_ENDPOINT",
      "OPENGENI_KERNEL_BROWSER_TIMEOUT_SECONDS",
      "OPENGENI_KERNEL_BROWSER_STEALTH",
    ]);
    expect(SANDBOX_REQUIRED_ENV.daytona.required).toEqual(["OPENGENI_DAYTONA_API_KEY"]);
    expect(SANDBOX_REQUIRED_ENV.opensandbox).toEqual({
      required: [
        "OPENGENI_OPENSANDBOX_BASE_URL",
        "OPENGENI_OPENSANDBOX_API_KEY",
        "OPENGENI_OPENSANDBOX_IMAGE",
      ],
      optional: [
        "OPENGENI_OPENSANDBOX_TTL_SECONDS",
        "OPENGENI_OPENSANDBOX_USE_SERVER_PROXY",
        "OPENGENI_OPENSANDBOX_SIGNED_ENDPOINTS",
        "OPENGENI_OPENSANDBOX_SIGNED_ENDPOINT_TTL_SECONDS",
        "OPENGENI_OPENSANDBOX_CHANNEL_B_PUBLIC_BASE_URL",
        "OPENGENI_OPENSANDBOX_INTERACTION_FRAME_PROXY",
        "OPENGENI_OPENSANDBOX_POOL_REF",
      ],
    });
    expect(SANDBOX_REQUIRED_ENV.docker.required).toEqual([]);
    expect(SANDBOX_REQUIRED_ENV.none.required).toEqual([]);
  });

  test("requiredRuntimeEnvVars surfaces ONLY the active backend's required creds", () => {
    const modalVars = requiredRuntimeEnvVars(withSandboxBackend("modal"));
    expect(modalVars).toContain("OPENGENI_MODAL_TOKEN_ID");
    expect(modalVars).toContain("OPENGENI_MODAL_TOKEN_SECRET");
    expect(modalVars).not.toContain("OPENGENI_DAYTONA_API_KEY");

    const daytonaVars = requiredRuntimeEnvVars(withSandboxBackend("daytona"));
    expect(daytonaVars).toContain("OPENGENI_DAYTONA_API_KEY");
    // a daytona deployment must NOT demand Modal creds.
    expect(daytonaVars).not.toContain("OPENGENI_MODAL_TOKEN_ID");
    expect(daytonaVars).not.toContain("OPENGENI_MODAL_TOKEN_SECRET");

    // docker needs no sandbox creds at all.
    const dockerVars = requiredRuntimeEnvVars(withSandboxBackend("docker"));
    expect(dockerVars).not.toContain("OPENGENI_MODAL_TOKEN_ID");
    expect(dockerVars).not.toContain("OPENGENI_DAYTONA_API_KEY");
  });

  test("renders the active backend's creds (required + optional) and nothing else", () => {
    const env = {
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_DAYTONA_API_KEY: "dk-secret",
      OPENGENI_DAYTONA_IMAGE: "ghcr.io/opengeni/sandbox:latest",
      // Modal creds present in env but the active backend is daytona — must NOT render.
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
    };
    const artifacts = generateRuntimeArtifacts(
      withSandboxBackend("daytona"),
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: {
          value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret",
          sensitive: true,
        },
        helm_set_values: { value: {} },
      },
      env,
    );

    expect(artifacts.runtimeEnv).toContain("OPENGENI_DAYTONA_API_KEY=dk-secret");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_DAYTONA_IMAGE=ghcr.io/opengeni/sandbox:latest",
    );
    // The inactive backend's creds leak nowhere even though they are in env.
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_MODAL_TOKEN_ID=");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_MODAL_TOKEN_SECRET=");
    // daytona's own required cred is not reported missing (it is set).
    expect(artifacts.missingEnvVars).not.toContain("OPENGENI_DAYTONA_API_KEY");
  });

  test("a missing active-backend cred surfaces in missingEnvVars (requiredEnv)", () => {
    const artifacts = generateRuntimeArtifacts(
      withSandboxBackend("daytona"),
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: { value: "x", sensitive: true },
        helm_set_values: { value: {} },
      },
      {},
    );
    expect(artifacts.missingEnvVars).toContain("OPENGENI_DAYTONA_API_KEY");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_DAYTONA_API_KEY=");
  });

  test("modal render still emits the full required + optional set (no regression)", () => {
    const env = {
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: testEnvironmentsEncryptionKey,
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_MODAL_APP_NAME: "opengeni-staging",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
      OPENGENI_MODAL_ENVIRONMENT: "staging",
      OPENGENI_MODAL_IMAGE_REF: "ghcr.io/opengeni/modal:latest",
    };
    const artifacts = generateRuntimeArtifacts(
      withSandboxBackend("modal"),
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: { value: "x", sensitive: true },
        helm_set_values: { value: {} },
      },
      env,
    );
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODAL_APP_NAME=opengeni-staging");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODAL_TOKEN_ID=modal-token-id");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODAL_TOKEN_SECRET=modal-token-secret");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODAL_TIMEOUT_SECONDS=900");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_MODAL_ENVIRONMENT=staging");
    expect(artifacts.runtimeEnv).toContain(
      "OPENGENI_MODAL_IMAGE_REF=ghcr.io/opengeni/modal:latest",
    );
  });

  test("renders the workspace control lock budget only when configured", () => {
    const outputs = {
      temporal_host: { value: "host:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "x", sensitive: true },
      helm_set_values: { value: {} },
    };
    const configured = generateRuntimeArtifacts(withSandboxBackend("docker"), outputs, {
      OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS: "45000",
    });
    expect(configured.runtimeEnv).toContain("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS=45000");
    expect(configured.missingEnvVars).not.toContain("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS");
    const absent = generateRuntimeArtifacts(withSandboxBackend("docker"), outputs, {});
    expect(absent.runtimeEnv).not.toContain("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS=");
    expect(absent.missingEnvVars).not.toContain("OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS");
  });

  test("renders the child lifecycle notices rollout flag only when configured", () => {
    const outputs = {
      temporal_host: { value: "host:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "x", sensitive: true },
      helm_set_values: { value: {} },
    };
    const configured = generateRuntimeArtifacts(withSandboxBackend("docker"), outputs, {
      OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED: "true",
      OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED: "true",
      OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED: "true",
      OPENGENI_WORK_DISCOVERY_ENABLED: "false",
      OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED: "false",
      OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED: "false",
      OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED: "true",
    });
    expect(configured.runtimeEnv).toContain("OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED=true");
    expect(configured.runtimeEnv).toContain(
      "OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED=true",
    );
    expect(configured.runtimeEnv).toContain("OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED=true");
    expect(configured.runtimeEnv).toContain("OPENGENI_WORK_DISCOVERY_ENABLED=false");
    expect(configured.runtimeEnv).toContain("OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED=false");
    expect(configured.runtimeEnv).toContain(
      "OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED=false",
    );
    expect(configured.runtimeEnv).toContain(
      "OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED=true",
    );
    expect(configured.missingEnvVars).not.toContain("OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED");
    expect(configured.missingEnvVars).not.toContain(
      "OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED",
    );
    const absent = generateRuntimeArtifacts(withSandboxBackend("docker"), outputs, {});
    expect(absent.runtimeEnv).not.toContain("OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED=");
    expect(absent.runtimeEnv).not.toContain(
      "OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED=",
    );
    expect(absent.runtimeEnv).not.toContain("OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED=");
    expect(absent.runtimeEnv).not.toContain("OPENGENI_WORK_DISCOVERY_ENABLED=");
    expect(absent.runtimeEnv).not.toContain("OPENGENI_WORK_CLAIM_MUTATIONS_ENABLED=");
    expect(absent.runtimeEnv).not.toContain("OPENGENI_WORK_DISCOVERY_HUMAN_ADVISORIES_ENABLED=");
    expect(absent.runtimeEnv).not.toContain("OPENGENI_WORK_DISCOVERY_AUTOMATIC_NUDGES_ENABLED=");
    expect(absent.missingEnvVars).not.toContain("OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED");
    expect(absent.missingEnvVars).not.toContain(
      "OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED",
    );
  });

  test("renders configured external browser providers without making them mandatory", () => {
    const env = {
      OPENGENI_BROWSERBASE_API_KEY: "browserbase-private",
      OPENGENI_KERNEL_API_KEY: "kernel-private",
      OPENGENI_KERNEL_ENDPOINT: "https://kernel.example.test",
      OPENGENI_KERNEL_BROWSER_TIMEOUT_SECONDS: "1800",
      OPENGENI_KERNEL_BROWSER_STEALTH: "true",
    };
    const artifacts = generateRuntimeArtifacts(
      withSandboxBackend("docker"),
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: { value: "x", sensitive: true },
        helm_set_values: { value: {} },
      },
      env,
    );

    for (const [key, value] of Object.entries(env)) {
      expect(artifacts.runtimeEnv).toContain(`${key}=${value}`);
      expect(artifacts.missingEnvVars).not.toContain(key);
    }
    const absent = generateRuntimeArtifacts(
      withSandboxBackend("docker"),
      {
        temporal_host: { value: "host:7233" },
        object_storage_bucket: { value: "opengeni-files" },
        object_storage_azure_connection_string: { value: "x", sensitive: true },
        helm_set_values: { value: {} },
      },
      {},
    );
    for (const key of EXTERNAL_BROWSER_PROVIDER_PASSTHROUGH_ENV) {
      expect(absent.runtimeEnv).not.toContain(`${key}=`);
      expect(absent.missingEnvVars).not.toContain(key);
    }
  });

  test("renders explicit sandbox rollout booleans through every deployment delivery mode", () => {
    const rolloutKeys = [
      "OPENGENI_SANDBOX_OWNERSHIP_ENABLED",
      "OPENGENI_SANDBOX_LAZY_PROVISION",
      "OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED",
    ] as const;
    for (const secretMode of SecretDeliveryMode.options) {
      const contract = parseDeploymentContract({
        ...deploymentProfiles["kubernetes-external"],
        secrets: { mode: secretMode },
      });
      for (const value of ["true", "false"] as const) {
        const artifacts = generateRuntimeArtifacts(
          contract,
          {},
          Object.fromEntries(rolloutKeys.map((key) => [key, value])),
        );
        for (const key of rolloutKeys) {
          expect(artifacts.runtimeEnv).toContain(`${key}=${value}`);
          expect(artifacts.summary.runtimeEnvKeys).toContain(key);
          expect(artifacts.missingEnvVars).not.toContain(key);
        }
      }

      const unset = generateRuntimeArtifacts(contract, {}, {});
      for (const key of rolloutKeys) {
        expect(unset.runtimeEnv).not.toContain(`${key}=`);
        expect(unset.summary.runtimeEnvKeys).not.toContain(key);
        expect(unset.missingEnvVars).not.toContain(key);
      }
    }
  });
});
