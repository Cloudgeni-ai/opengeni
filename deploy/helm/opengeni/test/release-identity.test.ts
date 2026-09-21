import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const chart = new URL("../", import.meta.url).pathname;
const helm = process.env.HELM_BIN ?? Bun.which("helm");
const revision = "a".repeat(40);

function render(extra: string[] = []) {
  const result = spawnSync(
    helm!,
    [
      "template",
      "opengeni",
      chart,
      "-n",
      "opengeni",
      "--set",
      "relay.enabled=true",
      "--set",
      "artifactMaterializer.enabled=true",
      "--set",
      "artifactOutboxDispatcher.enabled=true",
      ...extra,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return parseAllDocuments(result.stdout)
    .map((doc) => doc.toJSON())
    .filter(Boolean);
}

test.skipIf(!helm)(
  "ordinary chart renders one authoritative release identity in every runtime role",
  () => {
    const docs = render(["--set-string", `config.OPENGENI_DEPLOYMENT_REVISION=${revision}`]);
    for (const role of [
      "api",
      "worker-control",
      "worker-turns",
      "web",
      "relay",
      "artifact-materializer",
      "artifact-outbox-dispatcher",
    ]) {
      const deployment = docs.find(
        (doc) => doc.kind === "Deployment" && doc.metadata.name === `opengeni-${role}`,
      );
      expect(deployment).toBeDefined();
      expect(
        deployment.spec.template.spec.containers[0].env.filter(
          (env: { name: string }) => env.name === "OPENGENI_DEPLOYMENT_REVISION",
        ),
      ).toEqual([{ name: "OPENGENI_DEPLOYMENT_REVISION", value: revision }]);
    }
  },
);

test.skipIf(!helm)(
  "empty revision does not invent identity and web-only rendering remains valid",
  () => {
    for (const doc of render(["--set-string", "config.OPENGENI_DEPLOYMENT_REVISION="])) {
      if (doc.kind !== "Deployment") continue;
      expect(
        (doc.spec.template.spec.containers[0].env ?? []).filter(
          (env: { name: string }) => env.name === "OPENGENI_DEPLOYMENT_REVISION",
        ),
      ).toEqual([]);
    }
    const web = render([
      "--set",
      "api.enabled=false",
      "--set-string",
      `config.OPENGENI_DEPLOYMENT_REVISION=${revision}`,
    ]).find((doc) => doc.kind === "Deployment" && doc.metadata.name === "opengeni-web");
    expect(web.spec.template.spec.containers[0].env).toEqual([
      { name: "OPENGENI_DEPLOYMENT_REVISION", value: revision },
    ]);
  },
);
