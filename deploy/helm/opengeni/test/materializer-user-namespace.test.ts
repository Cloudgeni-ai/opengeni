import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm");
const chart = resolve(import.meta.dir, "..");
type Pod = {
  hostUsers?: boolean;
  securityContext: { runAsNonRoot: boolean };
  containers: Array<{
    securityContext: {
      allowPrivilegeEscalation: boolean;
      readOnlyRootFilesystem: boolean;
      capabilities: { drop: string[] };
      procMount?: string;
      appArmorProfile?: { type: string; localhostProfile: string };
    };
  }>;
};
type Deployment = {
  kind: string;
  metadata: { labels: Record<string, string> };
  spec: { template: { spec: Pod } };
};
async function render(materializer: Record<string, unknown> = {}) {
  if (!helm) throw Error("helm required for materializer user namespace tests");
  const child = Bun.spawn([helm, "template", "namespace-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify({ artifactMaterializer: { enabled: true, ...materializer } })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
function pods(stdout: string) {
  return new Map(
    parseAllDocuments(stdout)
      .map((document) => {
        expect(document.errors).toEqual([]);
        return document.toJS() as Deployment;
      })
      .filter((item) => item.kind === "Deployment")
      .map((item) => [
        item.metadata.labels["app.kubernetes.io/component"]!,
        item.spec.template.spec,
      ]),
  );
}
describe("materializer pod user namespace", () => {
  test("unset selection preserves default manifest", async () => {
    const result = await render();
    expect(result.code).toBe(0);
    expect(pods(result.stdout).get("artifact-materializer")!.hostUsers).toBeUndefined();
  });
  for (const hostUsers of [false, true]) {
    test(`explicit ${hostUsers} remains a boolean and affects only the materializer`, async () => {
      const result = await render({ hostUsers });
      expect(result.code).toBe(0);
      for (const [name, pod] of pods(result.stdout)) {
        expect(pod.hostUsers).toBe(name === "artifact-materializer" ? hostUsers : undefined);
      }
    });
  }
  test("user namespace permits scoped proc/AppArmor settings without increasing privileges", async () => {
    const result = await render({
      hostUsers: false,
      securityContext: {
        procMount: "Unmasked",
        appArmorProfile: { type: "Localhost", localhostProfile: "artifact-materializer" },
      },
    });
    expect(result.code).toBe(0);
    const pod = pods(result.stdout).get("artifact-materializer")!;
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.containers[0]!.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      procMount: "Unmasked",
      appArmorProfile: { type: "Localhost", localhostProfile: "artifact-materializer" },
    });
  });
  for (const hostUsers of [undefined, null, true]) {
    test(`rejects unmasked proc with hostUsers=${hostUsers}`, async () => {
      const result = await render({ hostUsers, securityContext: { procMount: "Unmasked" } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("requires artifactMaterializer.hostUsers=false");
    });
  }
  for (const hostUsers of ["false", "true", 0, 1, [], {}]) {
    test(`rejects nonboolean ${JSON.stringify(hostUsers)}`, async () => {
      const result = await render({ hostUsers });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("must be a boolean or null");
    });
  }
});
