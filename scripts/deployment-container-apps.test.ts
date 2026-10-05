import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deploymentProfiles, stackPlanFor } from "@opengeni/deployment";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function runScript(name: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--no-env-file", `scripts/${name}.ts`, ...args], {
    cwd: repoRoot,
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("ACA deployment operator CLI", () => {
  test("lists the profile and emits a native plan with prerequisites", () => {
    expect(runScript("deployment-preflight", ["--list"]).stdout).toContain("azure-container-apps");
    const result = runScript("deployment-stack", ["--profile", "azure-container-apps", "--json"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.terraformRoot).toBe("deploy/terraform/azure-container-apps");
    expect(plan.helmValuesFile).toBeNull();
    expect(plan.platformDependencies).toEqual([]);
    expect(plan.prerequisites.length).toBeGreaterThan(0);
    const text = runScript("deployment-stack", ["--profile", "azure-container-apps"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("Prerequisites");
    expect(text.stdout).not.toMatch(/\b(?:helm|kubectl|kubernetes|aks|chart)\b/i);
  });

  test("env preflight exposes missing names, not fake credentials or fixture defaults", () => {
    const result = runScript("deployment-preflight", [
      "--profile",
      "azure-container-apps",
      "--json",
      "--check-env",
    ]);
    expect(result.status).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.envOk).toBe(false);
    expect(output.modes.sandbox).toBe("modal");
    expect(output.missingEnvVars).toContain("OPENGENI_TEMPORAL_HOST");
    expect(output.missingEnvVars).toContain("OPENGENI_NATS_URL");
    expect(output.missingEnvVars).toContain("OPENGENI_MODAL_TOKEN_SECRET");
    expect(output.checks.some((check: { id: string }) => check.id === "kubernetes-context")).toBe(
      false,
    );
    expect(
      output.checks.some((check: { id: string }) => check.id === "azure-container-apps-context"),
    ).toBe(true);
  });

  test("refuses unsupported rendering before reading input or writing output, including allow-missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-render-"));
    try {
      const output = join(dir, "not-created");
      const result = runScript("deployment-runtime-artifacts", [
        "--profile",
        "azure-container-apps",
        "--terraform-output",
        join(dir, "not-readable.json"),
        "--out-dir",
        output,
        "--allow-missing",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not support azure-container-apps");
      expect(result.stderr).toContain("Key Vault secret references");
      expect(result.stderr).not.toContain("ENOENT");
      expect(existsSync(output)).toBe(false);
      expect(
        runScript("deployment-runtime-artifacts", ["--profile", "azure-container-apps"]).stderr,
      ).toContain("does not support azure-container-apps");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Azure CLI failure diagnostics discard arbitrary stderr and never call a cluster CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-preflight-"));
    const marker = "private-cli-error-marker";
    try {
      writeFileSync(join(dir, "az"), `#!/bin/sh\nprintf '${marker}\\n' >&2\nexit 19\n`, {
        mode: 0o755,
      });
      const result = runScript(
        "deployment-preflight",
        ["--profile", "azure-container-apps", "--json", "--live"],
        { PATH: `${dir}:${cleanEnv.PATH ?? ""}` },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(marker);
      const output = JSON.parse(result.stdout);
      expect(output.liveProbeScope).toContain("Partial operator-side");
      expect(
        output.liveResults.find(
          (item: { id: string }) => item.id === "azure-container-apps-context",
        ).status,
      ).toBe("failed");
      expect(
        output.liveResults.some((item: { id: string }) => item.id === "kubernetes-context"),
      ).toBe(false);
      expect(
        output.liveResults.find((item: { id: string }) => item.id === "object-storage-read-write")
          .status,
      ).toBe("skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only CLI availability never turns skipped conformance into readiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-preflight-readonly-"));
    try {
      const log = join(dir, "commands.log");
      writeFileSync(
        join(dir, "az"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$ACA_TEST_COMMAND_LOG"
case "$*" in
  'account show --query state --output tsv --only-show-errors') printf 'Enabled\\n' ;;
  'containerapp job execution show --help') exit 0 ;;
  *) exit 19 ;;
esac
`,
        { mode: 0o755 },
      );
      const marker = "private-invalid-base-url";
      const result = runScript(
        "deployment-preflight",
        ["--profile", "azure-container-apps", "--json", "--live"],
        {
          PATH: `${dir}:${cleanEnv.PATH ?? ""}`,
          ACA_TEST_COMMAND_LOG: log,
          OPENGENI_API_BASE_URL: marker,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(marker);
      const output = JSON.parse(result.stdout);
      expect(
        output.liveResults.find(
          (item: { id: string }) => item.id === "azure-container-apps-context",
        ).status,
      ).toBe("passed");
      expect(
        output.liveResults.find((item: { id: string }) => item.id === "object-storage-read-write")
          .status,
      ).toBe("skipped");
      expect(
        output.liveResults.find((item: { id: string }) => item.id === "api-health").status,
      ).toBe("failed");
      expect(readFileSync(log, "utf8")).not.toMatch(/\b(?:start|create|update|delete|destroy)\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ACA ordered workflow with fake operator CLIs", () => {
  for (const status of ["Succeeded", "Failed", "start-unknown", "gate-observation-unknown"]) {
    test(`enables applications only after the exact migration succeeds (${status})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-workflow-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "terraform"),
          `#!/bin/sh
set -eu
printf '%s\\n' "terraform $*" >> "$ACA_TEST_COMMAND_LOG"
test "$TF_DATA_DIR" = "$OPENGENI_ACA_TF_DATA_DIR"
for arg do case "$arg" in -state|-state=*) exit 19 ;; esac; done
test "$1" = '-chdir=deploy/terraform/azure-container-apps'
shift
if [ "$1" = init ]; then
  test "$#" -eq 3
  test "$2" = -reconfigure
  test "$3" = "-backend-config=path=$OPENGENI_ACA_STATE_FILE"
  printf '%s\\n' "$OPENGENI_ACA_STATE_FILE" > "$TF_DATA_DIR/backend-path"
  printf 'private-test-state\\n' > "$OPENGENI_ACA_STATE_FILE"
else
  test "$(head -n 1 "$TF_DATA_DIR/backend-path")" = "$OPENGENI_ACA_STATE_FILE"
  test -f "$OPENGENI_ACA_STATE_FILE"
fi
case "$*" in
  *' -raw resource_group_name'*) printf 'test-resource-group\\n' ;;
  *' -raw migration_job_name'*) printf 'test-migrations\\n' ;;
  *' -json migration_job'*) printf '{"image":"test-registry.example.test/api@sha256:${"1".repeat(64)}"}\\n' ;;
  *' -raw api_url'*) printf 'https://test.example.test\\n' ;;
esac
`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(bin, "az"),
          `#!/bin/sh
printf '%s\\n' "az $*" >> "$ACA_TEST_COMMAND_LOG"
case "$*" in
  *'job start'*)
    if [ "$ACA_TEST_JOB_STATUS" = start-unknown ]; then exit 17; fi
    printf 'test-migrations-exact-execution\\n' ;;
  *'job execution show'*)
    case "$*" in *'--job-execution-name test-migrations-exact-execution'*) ;; *) exit 18 ;; esac
    if [ "$ACA_TEST_JOB_STATUS" = gate-observation-unknown ]; then
      printf 'Succeeded\\n'
      if [ "$(grep -c 'az containerapp job execution show' "$ACA_TEST_COMMAND_LOG")" -gt 1 ]; then exit 17; fi
    else
      printf '%s\\n' "$ACA_TEST_JOB_STATUS"
    fi ;;
  *) exit 16 ;;
esac
`,
          { mode: 0o755 },
        );
        const plan = stackPlanFor(deploymentProfiles["azure-container-apps"], "none", {});
        const workflow = [
          ...plan.deployCommands,
          ...(status === "Succeeded" ? [plan.verifyCommands[0]!, ...plan.destroyCommands] : []),
        ];
        const result = spawnSync("bash", ["-e", "-c", workflow.join("\n")], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...cleanEnv,
            PATH: `${bin}:${cleanEnv.PATH ?? ""}`,
            OPENGENI_ACA_TFVARS_FILE: join(dir, "private variables.tfvars"),
            OPENGENI_ACA_STATE_FILE: join(dir, "private state.tfstate"),
            OPENGENI_ACA_TF_DATA_DIR: join(dir, "private terraform data"),
            ACA_TEST_COMMAND_LOG: join(dir, "commands.log"),
            ACA_TEST_JOB_STATUS: status,
          },
        });
        expect(result.error).toBeUndefined();
        const commands = readFileSync(join(dir, "commands.log"), "utf8");
        expect(commands).toContain(
          `init -reconfigure -backend-config=path=${join(dir, "private state.tfstate")}`,
        );
        expect(commands).not.toContain("-state=");
        expect(readFileSync(join(dir, "private terraform data", "backend-path"), "utf8")).toBe(
          `${join(dir, "private state.tfstate")}\n`,
        );
        expect(readFileSync(join(dir, "private state.tfstate"), "utf8")).toBe(
          "private-test-state\n",
        );
        expect(statSync(join(dir, "private state.tfstate")).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, "private terraform data")).mode & 0o777).toBe(0o700);
        expect(result.stdout + result.stderr).not.toContain("private-test-state");
        expect(commands.match(/az containerapp job start/g)).toHaveLength(1);
        expect(commands).toContain("deployment_phase=bootstrap");
        if (status === "Succeeded") {
          expect(result.status).toBe(0);
          expect(commands).toContain("deployment_phase=apps");
          expect(commands).toContain(
            "migration_completed_revision=test-registry.example.test/api@sha256:",
          );
          expect(commands.indexOf("job execution show")).toBeLessThan(
            commands.indexOf("deployment_phase=apps"),
          );
          expect(commands).toContain("output -raw api_url");
          expect(commands).toContain("plan -destroy -var-file=");
          expect(commands).toContain("destroy -var-file=");
        } else {
          expect(result.status).not.toBe(0);
          expect(commands).not.toContain("deployment_phase=apps");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("rejects a relative state path before initializing the backend", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-relative-state-"));
    try {
      const plan = stackPlanFor(deploymentProfiles["azure-container-apps"], "none", {});
      const result = spawnSync("bash", ["-e", "-c", plan.deployCommands.join("\n")], {
        cwd: dir,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...cleanEnv,
          OPENGENI_ACA_TFVARS_FILE: join(dir, "private.tfvars"),
          OPENGENI_ACA_STATE_FILE: "repository.tfstate",
          OPENGENI_ACA_TF_DATA_DIR: join(dir, "private terraform data"),
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ACA operator paths must be absolute");
      expect(existsSync(join(dir, "private terraform data"))).toBe(false);
      expect(existsSync(join(dir, "repository.tfstate"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("worker template readback requires both roles, always-on replicas, and drain grace", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-worker-readback-"));
    try {
      writeFileSync(join(dir, "az"), '#!/bin/sh\nprintf "%s\\n" "$ACA_TEST_WORKLOADS"\n', {
        mode: 0o755,
      });
      const worker = (role: string, minReplicas = 1, grace = 120) => ({
        name: `test-${role}`,
        properties: {
          template: {
            containers: [{ env: [{ name: "OPENGENI_WORKER_ROLE", value: role }] }],
            scale: { minReplicas },
            terminationGracePeriodSeconds: grace,
          },
        },
      });
      const command = stackPlanFor(
        deploymentProfiles["azure-container-apps"],
        "none",
        {},
      ).verifyCommands.find((item) => item.startsWith("az containerapp list"))!;
      for (const [workloads, expectedStatus] of [
        [[worker("control"), worker("turn")], 0],
        [[worker("control")], 1],
        [[worker("control"), worker("turn", 0)], 1],
        [[worker("control", 1, 90), worker("turn")], 1],
      ] as const) {
        const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...cleanEnv,
            PATH: `${dir}:${cleanEnv.PATH ?? ""}`,
            OPENGENI_ACA_RESOURCE_GROUP: "test-resource-group",
            ACA_TEST_WORKLOADS: JSON.stringify(workloads),
          },
        });
        expect(result.status).toBe(expectedStatus);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
