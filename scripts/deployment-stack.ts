import {
  DeploymentProfileId,
  ProductOverlayId,
  contractForProfile,
  stackPlanFor,
} from "@opengeni/deployment";

interface Args {
  profile: string;
  productOverlay: string;
  json: boolean;
  list: boolean;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const profile of DeploymentProfileId.options) {
    console.log(profile);
  }
  process.exit(0);
}

const profileId = DeploymentProfileId.parse(args.profile);
const overlay = ProductOverlayId.parse(args.productOverlay);
const plan = stackPlanFor(contractForProfile(profileId, overlay), overlay, process.env);

if (args.json) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

console.log(`OpenGeni deployment stack plan: ${plan.profile}`);
console.log("");
printList("Creates", plan.creates);
printPlatformDependencies();
printList("External dependencies", plan.externalDependencies);
printList("Required secret keys", plan.requiredSecretKeys);
printList("Deploy", plan.deployCommands);
printList("Verify", plan.verifyCommands);
printList("Destroy", plan.destroyCommands);
if (plan.terraformRoot) {
  console.log(`Terraform root: ${plan.terraformRoot}`);
}
if (plan.helmValuesFile) {
  console.log(`Helm values: ${plan.helmValuesFile}`);
}
printList("Notes", plan.notes);

function printPlatformDependencies(): void {
  console.log("");
  console.log("Platform dependencies");
  if (plan.platformDependencies.length === 0) {
    console.log("  - none");
    return;
  }
  for (const dependency of plan.platformDependencies) {
    console.log(`  - ${dependency.id}: ${dependency.lifecycle}`);
    console.log(`    namespace: ${dependency.namespace}`);
    console.log(`    release: ${dependency.releaseName}`);
    if (dependency.chartName) {
      console.log(`    chart: ${dependency.chartName}`);
    }
    if (dependency.valuesFile) {
      console.log(`    values: ${dependency.valuesFile}`);
    }
    const runtimeEnv = Object.entries(dependency.runtimeEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    if (runtimeEnv) {
      console.log(`    runtime env: ${runtimeEnv}`);
    }
    if (dependency.requiredEnvVars.length > 0) {
      console.log(`    required env: ${dependency.requiredEnvVars.join(", ")}`);
    }
    if (dependency.requiredSecretKeys.length > 0) {
      console.log(`    required secrets: ${dependency.requiredSecretKeys.join(", ")}`);
    }
  }
}

function printList(title: string, values: string[]): void {
  console.log("");
  console.log(title);
  if (values.length === 0) {
    console.log("  - none");
    return;
  }
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    profile: "local-compose",
    productOverlay: "none",
    json: false,
    list: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      out.json = true;
      continue;
    }
    if (value === "--list") {
      out.list = true;
      continue;
    }
    if (value === "--profile") {
      const next = values[index + 1];
      if (!next) {
        throw new Error("--profile requires a value");
      }
      out.profile = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--profile=")) {
      out.profile = value.slice("--profile=".length);
      continue;
    }
    if (value === "--product-overlay") {
      const next = values[index + 1];
      if (!next) {
        throw new Error("--product-overlay requires a value");
      }
      out.productOverlay = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--product-overlay=")) {
      out.productOverlay = value.slice("--product-overlay=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}
