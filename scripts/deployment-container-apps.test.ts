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

import {
  deploymentProfiles,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  stackPlanFor,
} from "@opengeni/deployment";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const completeManagedEnv = {
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_AUTH_REQUIRED: "false",
  OPENGENI_DATABASE_URL: "postgres://fixture:fixture@postgres.invalid/opengeni",
  OPENGENI_TEMPORAL_HOST: "temporal.invalid:7233",
  OPENGENI_NATS_URL: "nats://nats.invalid:4222",
  OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME: "fixtureaccount",
  OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY: "fixture-blob-key",
  OPENGENI_OPENAI_API_KEY: "fixture-model-key",
  OPENGENI_MODAL_APP_NAME: "fixture-modal-app",
  OPENGENI_MODAL_TOKEN_ID: "fixture-modal-id",
  OPENGENI_MODAL_TOKEN_SECRET: "fixture-modal-secret",
  OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
  OPENGENI_DELEGATION_SECRET: "fixture-host-secret",
  OPENGENI_BETTER_AUTH_SECRET: "fixture-browser-secret",
  OPENGENI_RESEND_API_KEY: "fixture-email-key",
  OPENGENI_EMAIL_FROM: "Fixture <fixture@example.test>",
  OPENGENI_GITHUB_APP_ID: "123",
  OPENGENI_GITHUB_CLIENT_ID: "fixture-github-client",
  OPENGENI_GITHUB_CLIENT_SECRET: "fixture-github-secret",
  OPENGENI_GITHUB_APP_SLUG: "fixture-app",
  OPENGENI_GITHUB_APP_PRIVATE_KEY: "fixture-github-private-key",
  OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: "fixture-github-manifest-secret",
};

function runScript(name: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--no-env-file", `scripts/${name}.ts`, ...args], {
    cwd: repoRoot,
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("ACA deployment operator CLI", () => {
  for (const [productAccessMode, accessMode] of [
    ["managed", "externalGateway"],
    ["configured", "sharedKey"],
  ] as const) {
    test(`executes generated ${productAccessMode}/${accessMode} preflight against the same accepted access contract`, () => {
      const profile = deploymentProfiles["azure-container-apps"];
      const contract = parseDeploymentContract({
        ...profile,
        access: { ...profile.access, mode: accessMode },
        product: {
          ...profile.product,
          accessMode: productAccessMode,
          publicBaseUrl: completeManagedEnv.OPENGENI_PUBLIC_BASE_URL,
        },
      });
      const env = {
        ...completeManagedEnv,
        OPENGENI_PRODUCT_ACCESS_MODE: productAccessMode,
        OPENGENI_AUTH_REQUIRED: String(accessMode === "sharedKey"),
        ...(accessMode === "sharedKey" ? { OPENGENI_ACCESS_KEY: "fixture-shared-key" } : {}),
      };
      expect(missingRuntimeEnvVars(contract, env)).toEqual([]);
      const generated = stackPlanFor(contract, "none", env).verifyCommands.find((command) =>
        command.startsWith("bun run deployment:preflight "),
      );
      expect(generated).toBeDefined();
      const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-preflight-command-"));
      try {
        // Execute the unmodified generated command with real Bun and the real
        // CLI; this wrapper only disables implicit checkout dotenv loading.
        writeFileSync(
          join(dir, "bun"),
          `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' --no-env-file "$@"\n`,
          { mode: 0o755 },
        );
        const execute = (selectedEnv: Record<string, string | undefined>) =>
          spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${generated} --json`], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...cleanEnv, ...selectedEnv, PATH: `${dir}:${cleanEnv.PATH}` },
          });
        const result = execute(env);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.envOk).toBe(true);
        expect(output.missingEnvVars).toEqual([]);
        expect(output.modes.access).toBe(accessMode);
        expect(output.modes.productAccess).toBe(productAccessMode);
        expect(output.requiredEnvVars.includes("OPENGENI_ACCESS_KEY")).toBe(
          accessMode === "sharedKey",
        );
        expect(result.stdout + result.stderr).not.toContain("fixture-shared-key");
        expect(result.stdout + result.stderr).not.toContain("fixture-host-secret");
        const withoutPublicEnv = { ...env, OPENGENI_PUBLIC_BASE_URL: undefined };
        expect(missingRuntimeEnvVars(contract, withoutPublicEnv)).toEqual([]);
        const carriedPublicBase = execute(withoutPublicEnv);
        expect(carriedPublicBase.status).toBe(0);
        expect(JSON.parse(carriedPublicBase.stdout).missingEnvVars).toEqual([]);
        const requiredSecret =
          accessMode === "sharedKey" ? "OPENGENI_ACCESS_KEY" : "OPENGENI_DELEGATION_SECRET";
        const missing = execute({ ...env, [requiredSecret]: undefined });
        expect(missing.status).toBe(2);
        const missingOutput = JSON.parse(missing.stdout);
        expect(missingOutput.missingEnvVars).toEqual([requiredSecret]);
        expect(missingOutput.modes.access).toBe(accessMode);
        expect(missingOutput.modes.productAccess).toBe(productAccessMode);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("preflight access selectors are explicit, paired, ACA-only and fail closed", () => {
    const selected = runScript(
      "deployment-preflight",
      [
        "--profile=azure-container-apps",
        "--product-access-mode=managed",
        "--access-mode=externalGateway",
        "--json",
        "--check-env",
      ],
      completeManagedEnv,
    );
    expect(selected.status).toBe(0);
    expect(JSON.parse(selected.stdout).modes.productAccess).toBe("managed");
    for (const args of [
      [
        "--profile",
        "azure-container-apps",
        "--product-access-mode",
        "managed",
        "--access-mode",
        "sharedKey",
      ],
      [
        "--profile",
        "azure-container-apps",
        "--product-access-mode",
        "configured",
        "--access-mode",
        "externalGateway",
      ],
      [
        "--profile",
        "azure-container-apps",
        "--product-access-mode",
        "local",
        "--access-mode",
        "disabled",
      ],
      ["--profile", "azure-container-apps", "--product-access-mode", "managed"],
      ["--profile", "azure-container-apps", "--access-mode", "externalGateway"],
      [
        "--profile",
        "azure-managed",
        "--product-access-mode",
        "managed",
        "--access-mode",
        "externalGateway",
      ],
    ]) {
      const result = runScript(
        "deployment-preflight",
        [...args, "--json", "--check-env"],
        completeManagedEnv,
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('"envOk": true');
      expect(result.stdout + result.stderr).not.toContain("fixture-host-secret");
    }
    const unchangedDefault = runScript(
      "deployment-preflight",
      ["--profile", "azure-container-apps", "--json", "--check-env"],
      completeManagedEnv,
    );
    expect(unchangedDefault.status).toBe(2);
    expect(JSON.parse(unchangedDefault.stdout).modes.productAccess).toBe("configured");
    expect(JSON.parse(unchangedDefault.stdout).missingEnvVars).toEqual(["OPENGENI_ACCESS_KEY"]);
  });

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
    "outbox-ready",
    "outbox-missing-digest",
    "outbox-wrong-registry",
    "outbox-mutable-image",
    "outbox-empty-image",
  ]) {
    test(`created ACR requires foundation, manual import, digest readback, then exact migration (${scenario})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-created-acr-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        const host = "task-created-acr.example.test";
        const images: { api: string; worker: string; web: string; outbox_dispatcher?: string } = {
          api: `${host}/opengeni/api@sha256:${"1".repeat(64)}`,
          worker: `${host}/opengeni/worker@sha256:${"2".repeat(64)}`,
          web: `${host}/opengeni/web@sha256:${"3".repeat(64)}`,
        };
        if (scenario.startsWith("outbox-")) {
          images.outbox_dispatcher = `${host}/opengeni/outbox@sha256:${"4".repeat(64)}`;
          if (scenario === "outbox-wrong-registry") {
            images.outbox_dispatcher = `foreign-registry.example.test/outbox@sha256:${"4".repeat(64)}`;
          } else if (scenario === "outbox-mutable-image") {
            images.outbox_dispatcher = `${host}/opengeni/outbox:latest`;
          } else if (scenario === "outbox-empty-image") {
            images.outbox_dispatcher = "";
          }
        }
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
    test "$(grep -c 'az acr repository show' "$ACA_TEST_COMMAND_LOG")" -eq ${images.outbox_dispatcher ? 4 : 3}
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
    fi
    if [ "$ACA_TEST_SCENARIO" = outbox-missing-digest ]; then
      case "$*" in *'--image opengeni/outbox@'*) printf '${privateMarker}\\n' >&2; exit 17 ;; esac
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
        if (scenario === "ready" || scenario === "job-failed" || scenario === "outbox-ready") {
          expect(commands.match(/az acr repository show/g)).toHaveLength(
            scenario === "outbox-ready" ? 4 : 3,
          );
          expect(commands).toContain(`--image opengeni/api@sha256:${"1".repeat(64)}`);
          expect(commands).toContain(`--image opengeni/worker@sha256:${"2".repeat(64)}`);
          expect(commands).toContain(`--image opengeni/web@sha256:${"3".repeat(64)}`);
          if (scenario === "outbox-ready") {
            expect(commands).toContain(`--image opengeni/outbox@sha256:${"4".repeat(64)}`);
          }
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
        if (scenario === "ready" || scenario === "outbox-ready") {
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
