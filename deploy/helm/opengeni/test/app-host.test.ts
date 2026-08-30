import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("dedicated Apps origin chart contract", () => {
  test("is disabled by default and ships as a separate least-privilege workload", async () => {
    const [values, deployment, service, dockerfile, builder, workspace] = await Promise.all([
      source("../values.yaml"),
      source("../templates/app-host-deployment.yaml"),
      source("../templates/app-host-service.yaml"),
      source("../../../../docker/opengeni.Dockerfile"),
      source("../../../../scripts/build-runtime-processes.ts"),
      source("../../../../scripts/ci/workspace.ts"),
    ]);

    expect(values).toContain("appHost:\n  enabled: false");
    expect(values).toContain("apps/app-host/dist/process/process.js");
    expect(deployment).toContain("app.kubernetes.io/component: app-host");
    expect(deployment).toContain("automountServiceAccountToken: false");
    expect(values).toContain("readOnlyRootFilesystem: true");
    expect(deployment).toContain("OPENGENI_APP_HOST_RESOLVER_KEY");
    expect(deployment).toContain("OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT");
    expect(deployment).toContain("OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT");
    expect(deployment).toContain("OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING");
    expect(deployment).not.toContain("envFrom:");
    expect(deployment).not.toContain("OPENGENI_DATABASE_URL");
    expect(deployment).not.toContain("OPENGENI_ACCESS_KEY");
    expect(deployment).not.toContain("OPENGENI_OPENAI_API_KEY");
    expect(service).toContain("targetPort: http");
    expect(builder).toContain('target !== "app-host"');
    expect(builder).toContain('apps/app-host/src/process.ts');
    expect(workspace).toContain('existsSync(join("apps/app-host", "tsconfig.json"))');
    expect(workspace).toContain('projects.push("apps/app-host")');
    expect(dockerfile).toContain("bun scripts/build-runtime-processes.ts api app-host");
  });

  test("uses a dedicated required host and permits only its resolver/storage egress", async () => {
    const [deployment, ingress, appPolicy, apiPolicy] = await Promise.all([
      source("../templates/app-host-deployment.yaml"),
      source("../templates/app-host-ingress.yaml"),
      source("../templates/app-host-networkpolicy.yaml"),
      source("../templates/api-networkpolicy.yaml"),
    ]);

    expect(deployment).toContain("/internal/apps/resolve-launch");
    expect(deployment).toContain(".Values.api.service.port");
    expect(ingress).toContain(
      'required "appHost.ingress.host is required when appHost.ingress.enabled=true"',
    );
    expect(ingress).toContain("name: {{ include \"opengeni.fullname\" . }}-app-host");
    expect(ingress).not.toContain("-api");
    expect(appPolicy).toContain("app.kubernetes.io/component: api");
    expect(appPolicy).toContain("app.kubernetes.io/component: garage");
    expect(appPolicy).toContain("app.kubernetes.io/component: minio");
    expect(appPolicy).toContain(".Values.networkPolicy.egress.rules");
    expect(apiPolicy).toContain("app.kubernetes.io/component: app-host");
  });
});
