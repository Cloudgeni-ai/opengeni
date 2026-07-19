import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);

async function values(name: string): Promise<string> {
  return await readFile(new URL(name, ROOT), "utf8");
}

function apiRoute(text: string, path: string): string {
  const match = text.match(
    new RegExp(
      `- path: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\s+pathType: (?:Exact|Prefix)\\n\\s+service: (\\w+)`,
    ),
  );
  return match?.[1] ?? "";
}

describe("Connected Machine public ingress contract", () => {
  test("the edge-exempt ingress exposes exactly the bootstrap/API route set", async () => {
    const source = await values("values.yaml");
    for (const path of [
      "/install.sh",
      "/install.ps1",
      "/uninstall.sh",
      "/opengeni-agent-minisign.pub",
      "/agent",
      "/v1/enrollments/device/start",
      "/v1/enrollments/device/poll",
      "/v1/enrollments/token/exchange",
      "/v1/enrollments/self/revoke",
    ]) {
      expect(apiRoute(source, path), path).toBe("api");
    }
    expect(source).not.toMatch(/publicIngress:[\s\S]*path: \/v1\/enrollments\/device\/lookup/);
  });

  test("the Azure managed example routes installer, agent, and bootstrap APIs to API", async () => {
    const source = await values("values.azure-managed.example.yaml");
    for (const path of [
      "/install.sh",
      "/install.ps1",
      "/uninstall.sh",
      "/opengeni-agent-minisign.pub",
      "/agent",
      "/v1/enrollments/device/start",
      "/v1/enrollments/device/poll",
      "/v1/enrollments/token/exchange",
      "/v1/enrollments/self/revoke",
    ]) {
      expect(apiRoute(source, path), path).toBe("api");
    }
  });
});
