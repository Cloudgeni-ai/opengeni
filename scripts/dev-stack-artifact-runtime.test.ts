import { describe, expect, test } from "bun:test";

const scriptPath = new URL("./dev-stack.sh", import.meta.url);
const sandboxDockerfilePath = new URL("../docker/sandbox.Dockerfile", import.meta.url);
const envExamplePath = new URL("../.env.example", import.meta.url);
const relaySupervisorPath = new URL("./run-development-relay.sh", import.meta.url);

describe("local artifact runtime stack contract", () => {
  test("script is valid shell and uses the strict current-host runtime producer", async () => {
    const syntax = Bun.spawn(["bash", "-n", scriptPath.pathname], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([syntax.exited, new Response(syntax.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const source = await Bun.file(scriptPath).text();
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun scripts/prepare-development-artifact-runtime.ts");
    expect(source).toContain("unset OPENGENI_ARTIFACT_RUNTIME_MANIFEST");
    expect(source).toContain("OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST");
    expect(source).toContain("OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE");
    expect(source).not.toMatch(/export OPENGENI_ARTIFACT_RUNTIME_MANIFEST=/u);
  });

  test("starts both dedicated artifact roles with isolated ports and credentials", async () => {
    const source = await Bun.file(scriptPath).text();
    expect(source).toContain("choose_port OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT 9465");
    expect(source).toContain("choose_port OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT 9466");
    expect(source).toContain(
      "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER=opengeni_artifact_materializer",
    );
    expect(source).toContain(
      "OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER=opengeni_artifact_outbox_dispatcher",
    );
    expect(source).toContain('randomBytes(24).toString("base64url")');
    expect(source).toContain("OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL");
    expect(source).toContain("OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL");
    expect(source).toContain("bun run start:artifact-materializer");
    expect(source).toContain("bun run start:artifact-outbox");

    const provision = source.indexOf("bun run provision-roles");
    const clearMaterializerPassword = source.indexOf(
      "unset OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD",
    );
    const clearOutboxPassword = source.indexOf("unset OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD");
    expect(clearMaterializerPassword).toBeGreaterThan(provision);
    expect(clearOutboxPassword).toBeGreaterThan(provision);
    expect(source.indexOf("bun run start:artifact-materializer")).toBeGreaterThan(provision);
    expect(source.indexOf("bun run start:artifact-outbox")).toBeGreaterThan(provision);
    expect(source.indexOf("bun run start:artifact-materializer")).toBeGreaterThan(
      clearMaterializerPassword,
    );
    expect(source.indexOf("bun run start:artifact-outbox")).toBeGreaterThan(clearOutboxPassword);
  });

  test("derives the local forced-RLS app-role password from its loopback DSN", async () => {
    const source = await Bun.file(scriptPath).text();
    expect(source).toContain('if [ -z "${OPENGENI_APP_DATABASE_PASSWORD:-}" ]');
    expect(source).toContain('OPENGENI_LOCAL_DATABASE_URL="$OPENGENI_DATABASE_URL"');
    expect(source).toContain(
      "Automatic local app-role password derivation requires a loopback database URL",
    );
    expect(source).toContain("export OPENGENI_APP_DATABASE_PASSWORD");
  });

  test("bridges standard local Modal credentials without persisting them", async () => {
    const source = await Bun.file(scriptPath).text();
    expect(source).toContain('[ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "modal" ]');
    expect(source).toContain(
      "Bun.TOML.parse(await Bun.file(`${Bun.env.HOME}/.modal.toml`).text())",
    );
    expect(source).toContain("Bun.env.MODAL_PROFILE?.trim()");
    expect(source).toContain("export OPENGENI_MODAL_TOKEN_ID OPENGENI_MODAL_TOKEN_SECRET");
    expect(source).not.toContain("printf 'OPENGENI_MODAL_TOKEN_ID=%s");
    expect(source).not.toContain("printf 'OPENGENI_MODAL_TOKEN_SECRET=%s");
  });

  test("isolates Modal sandbox ownership between local worktrees", async () => {
    const source = await Bun.file(scriptPath).text();

    expect(source).toContain('[ "${OPENGENI_PIN_MODAL_APP_NAME:-0}" != "1" ]');
    expect(source).toContain('OPENGENI_MODAL_APP_NAME="opengeni-${COMPOSE_PROJECT_NAME}"');
    expect(source).toContain("export OPENGENI_MODAL_APP_NAME");
    expect(source).toContain(
      "printf 'OPENGENI_MODAL_APP_NAME=%s\\n' \"${OPENGENI_MODAL_APP_NAME:-opengeni-sandbox}\"",
    );
  });

  test("makes local Connected Machines self-initializing", async () => {
    const [source, envExample] = await Promise.all([
      Bun.file(scriptPath).text(),
      Bun.file(envExamplePath).text(),
    ]);

    expect(envExample).toContain("OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true");
    expect(source).toContain('if [ -z "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-}" ]; then');
    expect(source).toContain("OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true");
    expect(source).toContain("OPENGENI_ENROLLMENT_SIGNING_SECRET");
    expect(source).toContain("OPENGENI_STREAM_TOKEN_SECRET");
    expect(source).toContain("OPENGENI_SELFHOSTED_NATS_URL");
    expect(source).toContain("OPENGENI_SELFHOSTED_RELAY_URL");
    expect(source).toContain("OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED");
    expect(source).toContain("OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD");
    expect(source).toContain("OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD");
    expect(source).toContain("bun scripts/prepare-development-nats-config.ts");
    expect(source).toContain("OPENGENI_NATS_CONFIG_FILE");
    expect(source).toContain("bash scripts/run-development-relay.sh");
  });

  test("enables interactive Browser and Computer surfaces locally by default", async () => {
    const source = await Bun.file(scriptPath).text();

    for (const setting of [
      "OPENGENI_SANDBOX_DESKTOP_ENABLED",
      "OPENGENI_SANDBOX_DESKTOP_INTERACTIVE",
      "OPENGENI_COMPUTER_USE_ENABLED",
    ]) {
      expect(source).toContain(`if [ -z "\${${setting}:-}" ]; then`);
      expect(source).toContain(`${setting}=true`);
      expect(source).toContain(`export ${setting}`);
    }
  });

  test("supervises the local relay and terminates its current child cleanly", async () => {
    const syntax = Bun.spawn(["bash", "-n", relaySupervisorPath.pathname], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr, source] = await Promise.all([
      syntax.exited,
      new Response(syntax.stderr).text(),
      Bun.file(relaySupervisorPath).text(),
    ]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(source).toContain('while [ "$stopping" = "0" ]');
    expect(source).toContain("cargo run --quiet -p opengeni-relay &");
    expect(source).toContain("trap cleanup EXIT INT TERM");
    expect(source).toContain('kill "$child_pid"');
  });

  test("unsandboxed execution is explicitly local, loopback, and visible in runtime env", async () => {
    const source = await Bun.file(scriptPath).text();
    for (const line of [
      "export NODE_ENV=development",
      "export OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT=true",
      "export OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT=true",
      "export OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST=127.0.0.1",
      "printf 'OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT=%s\\n'",
      "printf 'OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST=%s\\n'",
    ]) {
      expect(source).toContain(line);
    }
    expect(source).toContain("Local artifact services require a loopback database URL");
    expect(source).toContain(">.env.runtime");
  });

  test("host services use selected loopback MinIO while sandboxes keep compose DNS", async () => {
    const source = await Bun.file(scriptPath).text();
    const hostInternalEndpoint =
      'export OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT="${OPENGENI_OBJECT_STORAGE_ENDPOINT}"';
    const sandboxEndpoint = 'export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="http://minio:9000"';

    expect(source).toContain('default_internal_object_endpoint="http://minio:9000"');
    expect(source).toContain(hostInternalEndpoint);
    expect(source).toContain(sandboxEndpoint);
    expect(source).toContain(
      "printf 'OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT=%s\\n' \"${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}\"",
    );
    expect(source.indexOf(hostInternalEndpoint)).toBeLessThan(source.indexOf(">.env.runtime"));
    expect(source.indexOf(sandboxEndpoint)).toBeLessThan(source.indexOf(">.env.runtime"));
    expect(source).toContain("export OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin");
    expect(source).toContain("export OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin");
  });

  test("admits only an exact-head runtime in a source-tagged local image", async () => {
    const source = await Bun.file(scriptPath).text();
    expect(source).toContain("bun scripts/resolve-development-sandbox-runtime.ts");
    expect(source).toContain('sandbox_source_tag="$(git rev-parse --short=12 HEAD)"');
    expect(source).toContain(
      'OPENGENI_DOCKER_IMAGE="opengeni-sandbox:local-${sandbox_source_tag}"',
    );
    expect(source).toContain("OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=true");
    expect(source).toContain("OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=false");
    expect(source).toContain("OPENGENI_REQUIRE_SANDBOX_ARTIFACT_RUNTIME");
    expect(source).toContain(
      '--build-arg "OPENGENI_ARTIFACT_RUNTIME_BUNDLE=${sandbox_runtime_bundle}"',
    );
    expect(source).not.toContain("-t opengeni-sandbox:local .");
  });

  test("installs the locked verifier closure before verifying a clean sandbox image", async () => {
    const source = await Bun.file(sandboxDockerfilePath).text();
    const install = source.indexOf("bun install --frozen-lockfile");
    const verify = source.indexOf("bun scripts/verify-artifact-runtime-container-inputs.ts");
    const prepare = source.indexOf("bun scripts/prepare-artifact-sandbox-runtime.ts");

    expect(install).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(install);
    expect(prepare).toBeGreaterThan(verify);
  });
});
