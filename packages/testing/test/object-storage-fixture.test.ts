import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("Garage defaults do not use a MinIO client image", async () => {
  const compose = Bun.YAML.parse(
    await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
  ) as {
    services: Record<string, { image: string; entrypoint?: string[]; command?: string }>;
  };
  expect(compose.services["garage-init"]).toBeUndefined();
  expect(compose.services["minio-init"]!.image).toStartWith("quay.io/minio/mc:");
  expect(compose.services["minio-init"]!.entrypoint).toEqual(["/bin/sh", "-c"]);
  expect(compose.services["minio-init"]!.command).toContain(
    "mc mb --ignore-existing local/opengeni-files",
  );
  expect(compose.services.garage!.image).toStartWith("dxflrs/garage:");
  expect(compose.services.minio!.image).toStartWith("minio/minio:");
});
