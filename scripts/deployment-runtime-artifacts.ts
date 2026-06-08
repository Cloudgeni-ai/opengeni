import {
  DeploymentProfileId,
  ProductOverlayId,
  contractForProfile,
  generateRuntimeArtifacts,
  type TerraformOutputs,
} from "@opengeni/deployment";
import { mkdir } from "node:fs/promises";

interface Args {
  profile: string;
  productOverlay: string;
  terraformOutput: string;
  outDir: string;
  json: boolean;
  allowMissing: boolean;
}

const args = parseArgs(process.argv.slice(2));
const profileId = DeploymentProfileId.parse(args.profile);
const overlay = ProductOverlayId.parse(args.productOverlay);
const contract = contractForProfile(profileId, overlay);
const terraformOutputs = await readTerraformOutputs(args.terraformOutput);
const artifacts = generateRuntimeArtifacts(contract, terraformOutputs, process.env);

await mkdir(args.outDir, { recursive: true });
await Bun.write(`${args.outDir}/helm-values.generated.yaml`, artifacts.helmValuesYaml);
await Bun.write(`${args.outDir}/runtime.env`, artifacts.runtimeEnv);
await Bun.write(`${args.outDir}/summary.json`, `${JSON.stringify({
  profile: artifacts.profile,
  requiredEnvVars: artifacts.requiredEnvVars,
  missingEnvVars: artifacts.missingEnvVars,
  sensitiveTerraformOutputsUsed: artifacts.sensitiveTerraformOutputsUsed,
  summary: artifacts.summary,
}, null, 2)}\n`);

if (args.json) {
  console.log(JSON.stringify({
    profile: artifacts.profile,
    outDir: args.outDir,
    files: [
      `${args.outDir}/helm-values.generated.yaml`,
      `${args.outDir}/runtime.env`,
      `${args.outDir}/summary.json`,
    ],
    requiredEnvVars: artifacts.requiredEnvVars,
    missingEnvVars: artifacts.missingEnvVars,
    sensitiveTerraformOutputsUsed: artifacts.sensitiveTerraformOutputsUsed,
    summary: artifacts.summary,
  }, null, 2));
} else {
  console.log(`Generated deployment runtime artifacts for ${artifacts.profile}`);
  console.log(`  - ${args.outDir}/helm-values.generated.yaml`);
  console.log(`  - ${args.outDir}/runtime.env`);
  console.log(`  - ${args.outDir}/summary.json`);
  if (artifacts.missingEnvVars.length > 0) {
    console.log("Missing required environment variables:");
    for (const name of artifacts.missingEnvVars) {
      console.log(`  - ${name}`);
    }
  }
}

if (!args.allowMissing && artifacts.missingEnvVars.length > 0) {
  process.exit(2);
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    profile: "local-compose",
    productOverlay: "none",
    terraformOutput: "",
    outDir: ".agent/generated/deployment",
    json: false,
    allowMissing: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      out.json = true;
      continue;
    }
    if (value === "--allow-missing") {
      out.allowMissing = true;
      continue;
    }
    if (value === "--profile") {
      out.profile = requiredArg(values, index, "--profile");
      index += 1;
      continue;
    }
    if (value.startsWith("--profile=")) {
      out.profile = value.slice("--profile=".length);
      continue;
    }
    if (value === "--product-overlay") {
      out.productOverlay = requiredArg(values, index, "--product-overlay");
      index += 1;
      continue;
    }
    if (value.startsWith("--product-overlay=")) {
      out.productOverlay = value.slice("--product-overlay=".length);
      continue;
    }
    if (value === "--terraform-output") {
      out.terraformOutput = requiredArg(values, index, "--terraform-output");
      index += 1;
      continue;
    }
    if (value.startsWith("--terraform-output=")) {
      out.terraformOutput = value.slice("--terraform-output=".length);
      continue;
    }
    if (value === "--out-dir") {
      out.outDir = requiredArg(values, index, "--out-dir");
      index += 1;
      continue;
    }
    if (value.startsWith("--out-dir=")) {
      out.outDir = value.slice("--out-dir=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.terraformOutput) {
    throw new Error("--terraform-output is required");
  }
  return out;
}

function requiredArg(values: string[], index: number, name: string): string {
  const next = values[index + 1];
  if (!next) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

async function readTerraformOutputs(path: string): Promise<TerraformOutputs> {
  const raw = path === "-" ? await readStdin() : await Bun.file(path).text();
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Terraform output JSON must be an object");
  }
  return parsed as TerraformOutputs;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
