import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("in-cluster object-storage fixtures", () => {
  test("chart default keeps both fixtures off and fails if both are enabled", async () => {
    const values = await source("../values.yaml");
    const helpers = await source("../templates/_helpers.tpl");
    const garage = await source("../templates/garage-statefulset.yaml");
    const minio = await source("../templates/minio-statefulset.yaml");

    expect(values).toContain("garage:\n  enabled: false");
    expect(values).toContain("minio:\n  enabled: false");
    expect(helpers).toContain(
      "Enable only one in-cluster object-storage fixture: set garage.enabled or minio.enabled, not both",
    );
    expect(helpers).toContain(
      'value: {{ include "opengeni.objectStorageS3Provider" $root | quote }}',
    );
    expect(garage).toContain("opengeni.assertExclusiveObjectStorageFixture");
    expect(minio).toContain("opengeni.assertExclusiveObjectStorageFixture");
    expect(garage).not.toContain("opengeni.image");
    expect(garage).not.toContain("targetPort: rpc");
  });

  test("single-node and local-kubernetes examples enable Garage, not MinIO", async () => {
    const single = await source("../values.single-node.example.yaml");
    const local = await source("../values.local-kubernetes.example.yaml");
    const edge = await source("../templates/garage-edge-service.yaml");

    expect(single).toContain("garage:\n  enabled: true");
    expect(single).toContain("minio:\n  enabled: false");
    expect(single).toContain("OPENGENI_OBJECT_STORAGE_S3_PROVIDER: Other");
    expect(single).toContain("nodePort: 30900");
    expect(local).toContain("garage:\n  enabled: true");
    expect(local).toContain("minio:\n  enabled: false");
    expect(edge).toContain("targetPort: api");
    expect(edge).not.toContain("3901");
  });
});
