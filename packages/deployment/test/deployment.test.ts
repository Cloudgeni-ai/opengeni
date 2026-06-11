import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  contractForProfile,
  deploymentProfiles,
  generateRuntimeArtifacts,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  preflightChecksFor,
  requiredRuntimeEnvVars,
  stackPlanFor,
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
    expect(plan.deployCommands.some((command) => command.includes("kind load docker-image"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("opengeni-runtime-local-k8s"))).toBe(true);
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
    const variables = readFileSync(new URL("../../../deploy/terraform/azure/variables.tf", import.meta.url), "utf8");
    const main = readFileSync(new URL("../../../deploy/terraform/azure/main.tf", import.meta.url), "utf8");
    const outputs = readFileSync(new URL("../../../deploy/terraform/azure/outputs.tf", import.meta.url), "utf8");

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
    expect(() => parseDeploymentContract({
      ...deploymentProfiles["kubernetes-external"],
      access: { mode: "disabled" },
    })).toThrow("ingress-enabled deployments require shared-key auth or an external gateway");
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
    expect(stackPlanFor(pr).helmValuesFile).toBe("deploy/helm/opengeni/values.preview-managed.example.yaml");
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
    expect(vars).toContain("OPENGENI_NATS_URL");
    expect(vars).toContain("OPENGENI_AUTH_REQUIRED");
    expect(vars).toContain("OPENGENI_ACCESS_KEY");
    expect(vars).toContain("OPENGENI_DELEGATION_SECRET");
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
    expect(plan.platformDependencies.map((dependency) => dependency.id)).toEqual(["nats", "temporal"]);
    expect(plan.platformDependencies[0]?.chartName).toBe("nats/nats");
    expect(plan.platformDependencies[1]?.chartName).toBe("temporal/temporal");
    expect(plan.platformDependencies[0]?.runtimeEnv.OPENGENI_NATS_URL).toContain("opengeni-nats.opengeni-platform");
    expect(plan.platformDependencies[1]?.runtimeEnv.OPENGENI_TEMPORAL_HOST).toContain("opengeni-temporal-frontend.opengeni-platform");
    expect(plan.platformDependencies[1]?.requiredEnvVars).toContain("TEMPORAL_POSTGRES_HOST");
    expect(plan.platformDependencies[1]?.requiredEnvVars).toContain("TEMPORAL_POSTGRES_PASSWORD");
    expect(plan.creates).toContain("GKE cluster");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_ACCESS_KEY");
    expect(plan.requiredSecretKeys).toContain("OPENGENI_DELEGATION_SECRET");
    expect(plan.requiredSecretKeys).toContain("opengeni-temporal-postgres/password");
    expect(plan.deployCommands.some((command) => command.includes("helm repo add nats"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("helm repo add temporal"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("terraform -chdir=deploy/terraform/gcp apply"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("docker build") && command.includes("--target api"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("--target web") && command.includes("--build-arg OPENGENI_DEPLOYMENT_REVISION"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("docker push"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("deployment:runtime-artifacts"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes("opengeni-runtime"))).toBe(true);
    expect(plan.deployCommands.some((command) => command.includes(".agent/generated/gcp-managed/helm-values.generated.yaml"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("rollout status statefulset/opengeni-nats"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("helm test opengeni-nats"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("rollout status deployment/opengeni-temporal-frontend"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("helm test opengeni-temporal"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY"))).toBe(true);
    expect(plan.destroyCommands.some((command) => command.includes("helm uninstall opengeni-temporal"))).toBe(true);
    expect(plan.destroyCommands.some((command) => command.includes("helm uninstall opengeni-nats"))).toBe(true);
    expect(plan.destroyCommands.at(-1)).toContain("terraform -chdir=deploy/terraform/gcp destroy");
  });

  test("renders AWS Temporal TLS commands with concrete generated paths", () => {
    const plan = stackPlanFor(deploymentProfiles["aws-managed"]);
    const commands = plan.deployCommands.join("\n");

    expect(commands).toContain(".agent/generated/aws-managed/rds-global-bundle.pem");
    expect(commands).not.toContain("${contract.profile}");
  });

  test("renders Azure Temporal Postgres TLS by default", () => {
    const plan = stackPlanFor(deploymentProfiles["azure-managed"]);
    const commands = plan.deployCommands.join("\n");

    expect(commands).toContain('TEMPORAL_POSTGRES_TLS_ENABLED="${TEMPORAL_POSTGRES_TLS_ENABLED:-true}"');
    expect(commands).not.toContain("opengeni-postgres-ca");
  });

  test("does not plan cloud substrate for existing-service profiles", () => {
    const plan = stackPlanFor(deploymentProfiles["aws-existing-services"]);

    expect(plan.terraformRoot).toBeNull();
    expect(plan.platformDependencies).toEqual([]);
    expect(plan.externalDependencies).toContain("Postgres with pgvector reachable through OPENGENI_DATABASE_URL");
    expect(plan.destroyCommands.some((command) => command.includes("terraform"))).toBe(false);
  });

  test("generates private runtime artifacts from GCP Terraform outputs without hand-editing Helm paths", () => {
    const artifacts = generateRuntimeArtifacts(deploymentProfiles["gcp-managed"], {
      project_id: { value: "opengeni-example" },
      region: { value: "us-central1" },
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      temporal_namespace: { value: "default" },
      temporal_task_queue: { value: "opengeni-runs-ts" },
      object_storage_bucket: { value: "opengeni-example-files" },
      helm_set_values: {
        value: {
          "global.imageRegistry": "us-central1-docker.pkg.dev/opengeni-example/opengeni",
          "serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account": "opengeni-runtime@opengeni-example.iam.gserviceaccount.com",
          "config.OPENGENI_OBJECT_STORAGE_BUCKET": "opengeni-example-files",
        },
      },
    }, {
      OPENGENI_ACCESS_KEY: "test-access-key",
      OPENGENI_DELEGATION_SECRET: "test-delegation-secret",
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_IMAGE_TAG: "test-sha",
      OPENGENI_OPENAI_API_KEY: "openai",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.helmValuesYaml).toContain("imageRegistry: \"us-central1-docker.pkg.dev/opengeni-example/opengeni\"");
    expect(artifacts.helmValuesYaml).toContain("tag: \"test-sha\"");
    expect(artifacts.helmValuesYaml).toContain("OPENGENI_DEPLOYMENT_REVISION: \"test-sha\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"\"");
    expect(artifacts.helmValuesYaml).toContain("iam.gke.io/gcp-service-account: \"opengeni-runtime@opengeni-example.iam.gserviceaccount.com\"");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_OBJECT_STORAGE_BACKEND=gcs");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PRODUCT_ACCESS_MODE=configured");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_DEPLOYMENT_REVISION=test-sha");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID=opengeni-example");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_NATS_URL=nats://opengeni-nats.opengeni-platform.svc.cluster.local:4222");
    expect(artifacts.summary.secretNames).toContain("opengeni-runtime");
  });

  test("uses sensitive Azure Terraform connection string only in private runtime env", () => {
    const artifacts = generateRuntimeArtifacts(deploymentProfiles["azure-managed"], {
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      temporal_namespace: { value: "default" },
      temporal_task_queue: { value: "opengeni-runs-ts" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret", sensitive: true },
      helm_set_values: {
        value: {
          "global.imageRegistry": "opengeni.azurecr.io",
          "config.OPENGENI_OBJECT_STORAGE_BACKEND": "azure-blob",
        },
      },
    }, {
      OPENGENI_ACCESS_KEY: "test-access-key",
      OPENGENI_DELEGATION_SECRET: "test-delegation-secret",
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_OPENAI_API_KEY: "openai",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.sensitiveTerraformOutputsUsed).toEqual(["object_storage_azure_connection_string"]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret");
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
    expect(vars).toContain("OPENGENI_MODEL_PRICING_JSON");
    expect(vars).toContain("OPENGENI_MODAL_TOKEN_SECRET");
    expect(vars).not.toContain("OPENGENI_STATIC_USAGE_LIMITS_JSON");
    expect(plan.deployCommands.some((command) => command.includes("--product-overlay managed-saas-staging"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("OPENGENI_CONFORMANCE_PRODUCT_TOKEN"))).toBe(true);

    const artifacts = generateRuntimeArtifacts(contract, {
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret", sensitive: true },
      helm_set_values: { value: {} },
    }, {
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
      OPENGENI_GITHUB_APP_ID: "1",
      OPENGENI_GITHUB_CLIENT_ID: "github-client",
      OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
      OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
      OPENGENI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_MODEL_PRICING_JSON: "{\"gpt-5.5\":{\"inputMicrosPerMillionTokens\":5000000,\"cachedInputMicrosPerMillionTokens\":500000,\"outputMicrosPerMillionTokens\":30000000,\"marginBps\":2500}}",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/deployments/gpt-5.5",
      OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
      OPENGENI_IMAGE_TAG: "release-1",
      OPENGENI_API_IMAGE_DIGEST: "sha256:api",
      OPENGENI_WORKER_IMAGE_DIGEST: "sha256:worker",
      OPENGENI_WEB_IMAGE_DIGEST: "sha256:web",
      OPENGENI_MODAL_APP_NAME: "opengeni-staging",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_AUTH_REQUIRED=false");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PRODUCT_ACCESS_MODE=managed");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PUBLIC_BASE_URL=https://staging.app.opengeni.ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_BILLING_MODE=stripe");
    expect(artifacts.helmValuesYaml).toContain("tag: \"release-1\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:api\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:worker\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:web\"");
  });

  test("renders production managed SaaS posture as digest-pinned promotion without deployment shared key", () => {
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
    expect(plan.deployCommands.some((command) => command.includes("--product-overlay managed-saas-production"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("--base-url https://app.opengeni.ai"))).toBe(true);
    expect(plan.verifyCommands.some((command) => command.includes("OPENGENI_CONFORMANCE_PRODUCT_TOKEN"))).toBe(true);

    const artifacts = generateRuntimeArtifacts(contract, {
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret", sensitive: true },
      helm_set_values: { value: {} },
    }, {
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
      OPENGENI_GITHUB_APP_ID: "3971118",
      OPENGENI_GITHUB_CLIENT_ID: "prod-client",
      OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
      OPENGENI_GITHUB_APP_SLUG: "opengeni-ai",
      OPENGENI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_MODEL_PRICING_JSON: "{\"gpt-5.5\":{\"inputMicrosPerMillionTokens\":5000000,\"cachedInputMicrosPerMillionTokens\":500000,\"outputMicrosPerMillionTokens\":30000000,\"marginBps\":2500}}",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
      OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
      OPENGENI_IMAGE_TAG: "release-prod",
      OPENGENI_API_IMAGE_DIGEST: "sha256:api",
      OPENGENI_WORKER_IMAGE_DIGEST: "sha256:worker",
      OPENGENI_WEB_IMAGE_DIGEST: "sha256:web",
      OPENGENI_MODAL_APP_NAME: "opengeni-prod",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_AUTH_REQUIRED=false");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PUBLIC_BASE_URL=https://app.opengeni.ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS=https://app.opengeni.ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_EMAIL_FROM=OpenGeni <auth@mail.opengeni.ai>");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_GITHUB_APP_SLUG=opengeni-ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_BILLING_MODE=stripe");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_STRIPE_SECRET_KEY=sk_test");
    expect(artifacts.helmValuesYaml).toContain("OPENGENI_WEB_ALLOWED_HOSTS: \"app.opengeni.ai\"");
    expect(artifacts.helmValuesYaml).toContain("tag: \"release-prod\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:api\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:worker\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:web\"");
  });

  test("does not require legacy Azure api-version for Azure OpenAI v1 base URLs", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging");

    expect(requiredRuntimeEnvVars(contract, {
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
    })).not.toContain("OPENGENI_AZURE_OPENAI_API_VERSION");
    expect(requiredRuntimeEnvVars(contract, {
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/deployments/gpt-5.5",
    })).toContain("OPENGENI_AZURE_OPENAI_API_VERSION");

    const artifacts = generateRuntimeArtifacts(contract, {
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret", sensitive: true },
      helm_set_values: { value: {} },
    }, {
      OPENGENI_DATABASE_URL: "postgres://opengeni:secret@postgres/opengeni",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
      OPENGENI_GITHUB_APP_ID: "1",
      OPENGENI_GITHUB_CLIENT_ID: "github-client",
      OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
      OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
      OPENGENI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_MODEL_PRICING_JSON: "{\"gpt-5.5\":{\"inputMicrosPerMillionTokens\":5000000,\"cachedInputMicrosPerMillionTokens\":500000,\"outputMicrosPerMillionTokens\":30000000,\"marginBps\":2500}}",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1/",
      OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
      OPENGENI_IMAGE_TAG: "release-1",
      OPENGENI_API_IMAGE_DIGEST: "sha256:api",
      OPENGENI_WORKER_IMAGE_DIGEST: "sha256:worker",
      OPENGENI_WEB_IMAGE_DIGEST: "sha256:web",
      OPENGENI_MODAL_APP_NAME: "opengeni-staging",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).toContain("OPENGENI_AZURE_OPENAI_BASE_URL=https://example.openai.azure.com/openai/v1/");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_AZURE_OPENAI_API_VERSION=");
  });

  test("generates preview managed runtime artifacts without external fixture secrets", () => {
    const contract = contractForProfile("preview-pr");
    const artifacts = generateRuntimeArtifacts(contract, {
      helm_set_values: { value: {} },
    }, {
      OPENGENI_PUBLIC_BASE_URL: "https://preview-123.app.opengeni.ai",
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "state",
      OPENGENI_GITHUB_APP_ID: "1",
      OPENGENI_GITHUB_CLIENT_ID: "github-client",
      OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
      OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
      OPENGENI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_MODEL_PRICING_JSON: "{\"gpt-5.5\":{\"inputMicrosPerMillionTokens\":5000000,\"cachedInputMicrosPerMillionTokens\":500000,\"outputMicrosPerMillionTokens\":30000000,\"marginBps\":2500}}",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/deployments/gpt-5.5",
      OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
      OPENGENI_MODAL_APP_NAME: "opengeni-preview",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "300",
      OPENGENI_IMAGE_TAG: "preview-123",
      OPENGENI_API_IMAGE_DIGEST: "sha256:api",
      OPENGENI_WORKER_IMAGE_DIGEST: "sha256:worker",
      OPENGENI_WEB_IMAGE_DIGEST: "sha256:web",
    });

    expect(artifacts.missingEnvVars).toEqual([]);
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_DATABASE_URL=");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_OBJECT_STORAGE_ENDPOINT=");
    expect(artifacts.runtimeEnv).not.toContain("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_PUBLIC_BASE_URL=https://preview-123.app.opengeni.ai");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_SANDBOX_BACKEND=modal");
    expect(artifacts.helmValuesYaml).toContain("publicEndpoint: \"https://preview-123.app.opengeni.ai\"");
    expect(artifacts.helmValuesYaml).toContain("OPENGENI_WEB_ALLOWED_HOSTS: \"preview-123.app.opengeni.ai\"");
    expect(artifacts.helmValuesYaml).toContain("tag: \"preview-123\"");
    expect(artifacts.helmValuesYaml).toContain("digest: \"sha256:worker\"");
  });

  test("escapes multiline runtime env values for kubectl env-file secrets", () => {
    const contract = contractForProfile("azure-managed", "managed-saas-staging", {
      OPENGENI_STAGING_FINAL_BASE_URL: "https://staging.app.opengeni.ai",
    });
    const artifacts = generateRuntimeArtifacts(contract, {
      acr_login_server: { value: "opengeni.azurecr.io" },
      database_url: { value: "postgres://app:secret@example/opengeni" },
      object_storage_bucket: { value: "opengeni-files" },
      object_storage_azure_connection_string: { value: "DefaultEndpointsProtocol=https;AccountName=files;AccountKey=secret", sensitive: true },
      helm_set_values: { value: {} },
    }, {
      OPENGENI_DELEGATION_SECRET: "delegation",
      OPENGENI_BETTER_AUTH_SECRET: "better-auth",
      OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS: "https://staging.app.opengeni.ai",
      OPENGENI_RESEND_API_KEY: "resend",
      OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "github-state",
      OPENGENI_GITHUB_APP_MANIFEST_BASE_URL: "https://staging.app.opengeni.ai",
      OPENGENI_GITHUB_APP_ID: "1",
      OPENGENI_GITHUB_CLIENT_ID: "github-client",
      OPENGENI_GITHUB_CLIENT_SECRET: "github-secret",
      OPENGENI_GITHUB_APP_SLUG: "opengeni-staging",
      OPENGENI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_PUBLISHABLE_KEY: "pk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_MODEL_PRICING_JSON: "{\"gpt-5.5\":{\"inputMicrosPerMillionTokens\":5000000,\"cachedInputMicrosPerMillionTokens\":500000,\"outputMicrosPerMillionTokens\":30000000,\"marginBps\":2500}}",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/deployments/gpt-5.5",
      OPENGENI_AZURE_OPENAI_DEPLOYMENT: "gpt-5.5",
      OPENGENI_AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      OPENGENI_AZURE_OPENAI_API_KEY: "azure-openai",
      OPENGENI_MODAL_APP_NAME: "opengeni-staging",
      OPENGENI_MODAL_TOKEN_ID: "modal-token-id",
      OPENGENI_MODAL_TOKEN_SECRET: "modal-token-secret",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
    });

    const privateKeyLines = artifacts.runtimeEnv.split("\n").filter((line) => line.startsWith("OPENGENI_GITHUB_APP_PRIVATE_KEY="));
    expect(privateKeyLines).toHaveLength(1);
    expect(privateKeyLines[0]).toContain("-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----");
    expect(artifacts.runtimeEnv.split("\n").some((line) => line === "test")).toBe(false);
  });

  test("reports missing required runtime secrets without fabricating values", () => {
    const artifacts = generateRuntimeArtifacts(deploymentProfiles["aws-managed"], {
      region: { value: "us-east-1" },
      temporal_host: { value: "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" },
      object_storage_bucket: { value: "opengeni-files" },
      helm_set_values: { value: {} },
    }, {});

    expect(artifacts.missingEnvVars).toContain("OPENGENI_ACCESS_KEY");
    expect(artifacts.missingEnvVars).toContain("OPENGENI_DELEGATION_SECRET");
    expect(artifacts.missingEnvVars).toContain("OPENGENI_DATABASE_URL");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_ACCESS_KEY=");
    expect(artifacts.runtimeEnv).toContain("OPENGENI_DATABASE_URL=");
  });
});
