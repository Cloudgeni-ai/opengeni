import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("OpenSandbox Kubernetes inventory chart contract", () => {
  test("renders only for the selected backend with list-only cross-namespace RBAC", async () => {
    const [deployment, rbac, values] = await Promise.all([
      readFile(new URL("../templates/worker-deployment.yaml", import.meta.url), "utf8"),
      readFile(
        new URL("../templates/opensandbox-kubernetes-inventory-rbac.yaml", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../values.yaml", import.meta.url), "utf8"),
    ]);

    expect(values).toContain("automountServiceAccountToken: false");
    expect(values).toContain("kubernetesInventory:");
    expect(values).toContain("namespace: opensandbox");
    expect(deployment).toContain("OPENGENI_OPENSANDBOX_KUBERNETES_INVENTORY_NAMESPACE");
    expect(deployment).toContain("serviceAccountToken:");
    expect(deployment).toContain("kube-root-ca.crt");
    expect(deployment).toContain("opensandbox-kubernetes-inventory");
    expect(rbac).toContain(
      'eq (default "none" (index .Values.config "OPENGENI_SANDBOX_BACKEND")) "opensandbox"',
    );
    expect(rbac).toContain('resources: ["pods"]');
    expect(rbac).toContain('resources: ["batchsandboxes"]');
    expect(rbac).toContain('verbs: ["list"]');
    expect(rbac).not.toMatch(/verbs:\s*\[[^\]]*"(?:watch|create|update|patch|delete|get)"[^\]]*\]/);
    expect(rbac).toContain("namespace: {{ .Release.Namespace | quote }}");
  });
});
