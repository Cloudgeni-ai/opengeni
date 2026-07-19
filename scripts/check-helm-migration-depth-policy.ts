type MigrationJob = {
  kind?: unknown;
  metadata?: {
    annotations?: Record<string, unknown>;
  };
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          name?: unknown;
          envFrom?: Array<{
            configMapRef?: {
              name?: unknown;
            };
          }>;
          env?: Array<{
            name?: unknown;
            value?: unknown;
          }>;
        }>;
      };
    };
  };
};

const chart = "deploy/helm/opengeni";
const policyName = "OPENGENI_MAX_NESTED_AGENT_DEPTH";

for (const check of [
  { name: "default", expected: "3", override: null },
  { name: "custom", expected: "7", override: "7" },
]) {
  const manifest = await renderMigrationJob(check.name, check.override);
  assertMigrationPolicy(manifest, check.expected);
}

console.log(
  "Helm migration depth-policy guard passed: pre-upgrade hook pins default and custom policy values directly.",
);

async function renderMigrationJob(name: string, override: string | null): Promise<MigrationJob> {
  const command = [
    "helm",
    "template",
    `opengeni-depth-${name}`,
    chart,
    "--show-only",
    "templates/migration-job.yaml",
  ];
  if (override !== null) {
    command.push("--set-string", `config.${policyName}=${override}`);
  }
  const process = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  const parsed: unknown = Bun.YAML.parse(stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Helm migration template did not render one YAML object");
  }
  return parsed as MigrationJob;
}

function assertMigrationPolicy(manifest: MigrationJob, expected: string): void {
  if (manifest.kind !== "Job") {
    throw new Error(`Expected migration manifest kind Job, received ${String(manifest.kind)}`);
  }
  const hook = manifest.metadata?.annotations?.["helm.sh/hook"];
  if (typeof hook !== "string" || !hook.split(",").includes("pre-upgrade")) {
    throw new Error("Migration Job must remain a pre-upgrade hook");
  }
  const containers = manifest.spec?.template?.spec?.containers ?? [];
  const migration = containers.find((container) => container.name === "migrate");
  if (!migration) {
    throw new Error("Rendered migration Job is missing the migrate container");
  }
  const configMapRefs = migration.envFrom?.flatMap((entry) =>
    typeof entry.configMapRef?.name === "string" ? [entry.configMapRef.name] : [],
  );
  if (!configMapRefs || configMapRefs.length === 0) {
    throw new Error("Migration Job no longer consumes the release ConfigMap fixture");
  }
  const policyEntries = migration.env?.filter((entry) => entry.name === policyName) ?? [];
  if (policyEntries.length !== 1 || policyEntries[0]?.value !== expected) {
    throw new Error(
      `Migration Job must pin one direct ${policyName}=${expected}; received ${JSON.stringify(policyEntries)}`,
    );
  }
}
