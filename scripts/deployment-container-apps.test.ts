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

  test("selects created-ACR mode explicitly without changing other profiles", () => {
    const result = runScript("deployment-stack", [
      "--profile",
      "azure-container-apps",
      "--create-acr",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.creates).toContain("task-owned Azure Container Registry");
    expect(plan.deployCommands.join("\n")).toContain("-var=deployment_phase=foundation");
    expect(plan.deployCommands.join("\n")).toContain("-var=create_acr=true");
    const wrongProfile = runScript("deployment-stack", [
      "--profile",
      "local-compose",
      "--create-acr",
    ]);
    expect(wrongProfile.status).not.toBe(0);
    expect(wrongProfile.stderr).toContain("supported only for the azure-container-apps profile");
    const invalidMode = runScript("deployment-stack", ["--profile", "azure-container-apps"], {
      OPENGENI_ACA_CREATE_ACR: "yes",
    });
    expect(invalidMode.status).not.toBe(0);
    expect(invalidMode.stderr).toContain("OPENGENI_ACA_CREATE_ACR must be exactly true or false");
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
        expect(commands).not.toContain("deployment_phase=foundation");
        expect(commands).not.toContain("az acr");
        for (const command of commands.split("\n")) {
          if (/^terraform .* (?:plan|apply|destroy) /.test(command)) {
            expect(command).toContain("-var=create_acr=false");
          }
        }
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

  for (const scenario of [
    "ready",
    "imports-unacknowledged",
    "wrong-ack",
    "missing-digest",
    "wrong-registry",
    "mutable-image",
    "foundation-failed",
    "acr-output-unknown",
    "acr-output-error",
    "console-unknown",
    "job-failed",
  ]) {
    test(`created ACR requires foundation, manual import, digest readback, then exact migration (${scenario})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-created-acr-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        const host = "task-created-acr.example.test";
        const images = {
          api: `${host}/opengeni/api@sha256:${"1".repeat(64)}`,
          worker: `${host}/opengeni/worker@sha256:${"2".repeat(64)}`,
          web: `${host}/opengeni/web@sha256:${"3".repeat(64)}`,
        };
        if (scenario === "wrong-registry") {
          images.worker = `foreign-registry.example.test/worker@sha256:${"2".repeat(64)}`;
        } else if (scenario === "mutable-image") {
          images.worker = `${host}/opengeni/worker:latest`;
        }
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
else
  test "$(head -n 1 "$TF_DATA_DIR/backend-path")" = "$OPENGENI_ACA_STATE_FILE"
fi
case "$1" in
  plan|apply|destroy|console) case "$*" in *'-var=create_acr=true'*) ;; *) exit 19 ;; esac ;;
esac
case "$*" in
  'console '*)
    IFS= read -r expression
    test "$expression" = 'jsonencode(var.images)'
    test -f "$TF_DATA_DIR/foundation-applied"
    printf '%s\\n' "$ACA_TEST_IMAGE_CONSOLE"
    if [ "$ACA_TEST_SCENARIO" = console-unknown ]; then exit 17; fi ;;
  *' -json acr')
    test -f "$TF_DATA_DIR/foundation-applied"
    if [ "$ACA_TEST_SCENARIO" = acr-output-unknown ]; then printf 'null\\n'; else printf '{"name":"taskCreatedAcr","login_server":"${host}"}\\n'; fi
    if [ "$ACA_TEST_SCENARIO" = acr-output-error ]; then exit 17; fi ;;
  *' -raw resource_group_name') printf 'test-resource-group\\n' ;;
  *' -raw migration_job_name') test -f "$TF_DATA_DIR/bootstrap-applied"; printf 'test-migrations\\n' ;;
  *' -json migration_job') printf '{"image":"${images.api}"}\\n' ;;
  *'deployment_phase=foundation'*)
    if [ "$1" = apply ]; then
      if [ "$ACA_TEST_SCENARIO" = foundation-failed ]; then exit 17; fi
      printf 'applied\\n' > "$TF_DATA_DIR/foundation-applied"
    fi ;;
  *'deployment_phase=bootstrap'*)
    test -f "$TF_DATA_DIR/foundation-applied"
    test "$(grep -c 'az acr repository show' "$ACA_TEST_COMMAND_LOG")" -eq 3
    if [ "$1" = apply ]; then printf 'applied\\n' > "$TF_DATA_DIR/bootstrap-applied"; fi ;;
esac
`,
          { mode: 0o755 },
        );
        const privateMarker = "private-image-readback-error";
        writeFileSync(
          join(bin, "az"),
          `#!/bin/sh
set -eu
printf '%s\\n' "az $*" >> "$ACA_TEST_COMMAND_LOG"
case "$*" in
  'acr repository show --name taskCreatedAcr --image '*)
    test -f "$TF_DATA_DIR/foundation-applied"
    test ! -f "$TF_DATA_DIR/bootstrap-applied"
    case "$*" in *'--output none --only-show-errors') ;; *) exit 19 ;; esac
    if [ "$ACA_TEST_SCENARIO" = missing-digest ]; then
      case "$*" in *'--image opengeni/worker@'*) printf '${privateMarker}\\n' >&2; exit 17 ;; esac
    fi ;;
  *'job start'*) test -f "$TF_DATA_DIR/bootstrap-applied"; printf 'test-migrations-exact-execution\\n' ;;
  *'job execution show'*)
    case "$*" in *'--job-execution-name test-migrations-exact-execution'*) ;; *) exit 18 ;; esac
    if [ "$ACA_TEST_SCENARIO" = job-failed ]; then printf 'Failed\\n'; else printf 'Succeeded\\n'; fi ;;
  *) exit 19 ;;
esac
`,
          { mode: 0o755 },
        );
        const plan = stackPlanFor(deploymentProfiles["azure-container-apps"], "none", {
          OPENGENI_ACA_CREATE_ACR: "true",
        });
        const result = spawnSync("bash", ["-e", "-c", plan.deployCommands.join("\n")], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...cleanEnv,
            PATH: `${bin}:${cleanEnv.PATH ?? ""}`,
            OPENGENI_ACA_TFVARS_FILE: join(dir, "private variables.tfvars"),
            OPENGENI_ACA_STATE_FILE: join(dir, "private state.tfstate"),
            OPENGENI_ACA_TF_DATA_DIR: join(dir, "private terraform data"),
            OPENGENI_ACA_ACR_NAME: "taskCreatedAcr",
            OPENGENI_ACA_ACR_LOGIN_SERVER: host,
            OPENGENI_ACA_ACR_IMPORTS_COMPLETED:
              scenario === "imports-unacknowledged"
                ? ""
                : scenario === "wrong-ack"
                  ? "foreign-registry.example.test"
                  : host,
            ACA_TEST_COMMAND_LOG: join(dir, "commands.log"),
            ACA_TEST_SCENARIO: scenario,
            ACA_TEST_IMAGE_CONSOLE: JSON.stringify(JSON.stringify(images)),
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.stdout + result.stderr).not.toContain(privateMarker);
        const commands = readFileSync(join(dir, "commands.log"), "utf8");
        expect(commands).toContain("deployment_phase=foundation");
        expect(commands).not.toContain("-state=");
        expect(commands).not.toMatch(/\baz acr (?:import|login|build)\b/);
        if (scenario === "ready" || scenario === "job-failed") {
          expect(commands.match(/az acr repository show/g)).toHaveLength(3);
          expect(commands).toContain(`--image opengeni/api@sha256:${"1".repeat(64)}`);
          expect(commands).toContain(`--image opengeni/worker@sha256:${"2".repeat(64)}`);
          expect(commands).toContain(`--image opengeni/web@sha256:${"3".repeat(64)}`);
          expect(commands.indexOf("output -json acr")).toBeLessThan(
            commands.indexOf("az acr repository show"),
          );
          expect(commands.lastIndexOf("az acr repository show")).toBeLessThan(
            commands.indexOf("deployment_phase=bootstrap"),
          );
          expect(commands.indexOf("deployment_phase=bootstrap")).toBeLessThan(
            commands.indexOf("az containerapp job start"),
          );
          expect(commands.match(/az containerapp job start/g)).toHaveLength(1);
        } else {
          expect(result.status).not.toBe(0);
          expect(commands).not.toContain("deployment_phase=bootstrap");
          expect(commands).not.toContain("az containerapp job start");
          expect(commands).not.toContain("deployment_phase=apps");
        }
        if (scenario === "ready") {
          expect(result.status).toBe(0);
          expect(commands).toContain("deployment_phase=apps");
          expect(commands).toContain(`migration_completed_revision=${images.api}`);
          expect(commands.indexOf("job execution show")).toBeLessThan(
            commands.indexOf("deployment_phase=apps"),
          );
        } else if (scenario === "job-failed") {
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
