import { detectTarget, toolBin } from "./install-development-tools";
import { resolveFixture } from "./dev-native-storage";
import { join } from "node:path";

// Only probe/launch selectors cross this boundary, never the full dotenv or
// Docker auth contents. Keep values internal: even an endpoint may carry auth.
const preflightKeys = [
  "PATH",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "RUSTUP_AUTO_INSTALL",
  "OPENGENI_DEV_BACKEND",
  "OPENGENI_DOCKER_PROBE_TIMEOUT_SECONDS",
  "OPENGENI_OBJECT_STORAGE_FIXTURE",
  "OPENGENI_SANDBOX_BACKEND",
  "OPENGENI_SANDBOX_SELFHOSTED_ENABLED",
  "OPENGENI_SELFHOSTED_RELAY_URL",
  "OPENGENI_RELAY_BIND",
  "OPENGENI_COMPOSE_PROJECT",
] as const;

/** Read the launcher's exact dotenv precedence without creating config or state. */
export function readDevelopmentLaunchEnvironment(repositoryRoot: string): {
  environment: NodeJS.ProcessEnv;
  project: string;
} {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(
      "The full OpenGeni stack uses Bash and Unix processes. On Windows, run inside WSL2 with the checkout and tools in Linux.",
    );
  }
  if (!Bun.which("bash")) throw new Error("Missing bash. Install Bash before running OpenGeni.");
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      `set -e
{
. ./scripts/dev-stack-backend.sh
if [ -f .env ]; then
  opengeni_load_dev_environment ./.env
elif [ -f .env.example ]; then
  opengeni_load_dev_environment ./.env.example
fi
. ./scripts/dev-stack-project.sh
export COMPOSE_PROJECT_NAME="$(resolve_compose_project_name)"
} >/dev/null 2>&1
exec "$1" --no-env-file -e "$2"`,
      "opengeni-preflight",
      process.execPath,
      `process.stdout.write(JSON.stringify({project:process.env.COMPOSE_PROJECT_NAME,environment:Object.fromEntries(${JSON.stringify(preflightKeys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))}))`,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "Cannot read local startup configuration. Check .env shell syntax and project settings; no services were started.",
    );
  }
  let snapshot: { project?: unknown; environment: Record<string, unknown> };
  try {
    snapshot = JSON.parse(result.stdout.toString());
    if (!snapshot || typeof snapshot.environment !== "object" || !snapshot.environment)
      throw new Error("Invalid snapshot");
  } catch {
    // Bun's JSON errors can quote the input. Never surface captured shell output.
    throw new Error("Cannot read local startup configuration; no services were started.");
  }
  if (typeof snapshot.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(snapshot.project)) {
    throw new Error("Invalid development stack project name");
  }
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of preflightKeys) {
    if (typeof snapshot.environment?.[key] === "string")
      environment[key] = snapshot.environment[key];
    else delete environment[key];
  }
  // Reuse the installer's exact pinned directory without installing anything.
  environment.PATH = `${toolBin(repositoryRoot, detectTarget())}:${environment.PATH ?? ""}`;
  environment.COMPOSE_PROJECT_NAME = snapshot.project;
  return { environment, project: snapshot.project };
}

export function resolveDevelopmentLaunchBackend(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  project: string,
): NodeJS.ProcessEnv {
  const result = Bun.spawnSync(
    ["bash", "-c", ". ./scripts/dev-stack-backend.sh; opengeni_resolve_dev_backend"],
    { cwd: repositoryRoot, env: environment, stdout: "pipe", stderr: "pipe", timeout: 65_000 },
  );
  const backend = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !["docker", "native"].includes(backend)) {
    // The checker can aggregate its detailed backend diagnostic with missing
    // host tools. Preserve the original request instead of guessing a backend.
    return environment;
  }
  return {
    ...environment,
    OPENGENI_DEV_BACKEND: backend,
    ...(backend === "native"
      ? {
          OPENGENI_OBJECT_STORAGE_FIXTURE: resolveFixture(
            join(repositoryRoot, ".opengeni", "native", project),
            environment.OPENGENI_OBJECT_STORAGE_FIXTURE,
          ),
        }
      : {}),
  };
}
