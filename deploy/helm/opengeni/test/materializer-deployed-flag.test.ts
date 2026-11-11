import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const helm = Bun.which("helm");
const chart = resolve(import.meta.dir, "..");

async function configMap(values: Record<string, unknown>): Promise<Record<string, string>> {
  if (!helm) throw Error("helm required for materializer deployed flag tests");
  const child = Bun.spawn([helm, "template", "flag-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const map = parseAllDocuments(stdout)
    .map((document) => {
      // Duplicate keys surface as parse errors.
      expect(document.errors).toEqual([]);
      return document.toJS() as {
        kind?: string;
        metadata?: { name?: string };
        data?: Record<string, string>;
      };
    })
    .find((item) => item?.kind === "ConfigMap" && item.metadata?.name?.endsWith("-config"));
  return map!.data!;
}

describe("API/worker materializer deployment fact", () => {
  test("follows artifactMaterializer.enabled", async () => {
    expect((await configMap({}))["OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED"]).toBe("false");
    expect(
      (await configMap({ artifactMaterializer: { enabled: true } }))[
        "OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED"
      ],
    ).toBe("true");
  });

  test("an explicit config value wins and is not duplicated", async () => {
    const data = await configMap({
      config: { OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED: "true" },
    });
    expect(data["OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED"]).toBe("true");
  });
});
