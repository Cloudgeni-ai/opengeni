import { describe, expect, test } from "bun:test";

const scriptPath = new URL("./dev-stack.sh", import.meta.url);

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
  });
});
