import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GARAGE_FIXTURE_MC_IMAGE } from "../src/object-storage-fixture";

test("object-storage bootstrap clients share the official immutable release image", async () => {
  const compose = Bun.YAML.parse(
    await readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
  ) as {
    services: Record<string, { image: string; entrypoint?: string[]; command?: string }>;
  };
  expect(GARAGE_FIXTURE_MC_IMAGE).toBe(
    "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
  );
  for (const service of ["garage-init", "minio-init"]) {
    expect(compose.services[service]!.image).toBe(GARAGE_FIXTURE_MC_IMAGE);
    expect(compose.services[service]!.entrypoint).toEqual(["/bin/sh", "-c"]);
  }
  expect(compose.services["garage-init"]!.command).toContain(
    "mc cors set local/opengeni-files /cors.xml",
  );
  expect(compose.services["minio-init"]!.command).toContain(
    "mc mb --ignore-existing local/opengeni-files",
  );
  expect(compose.services.garage!.image).toStartWith("dxflrs/garage:");
  expect(compose.services.minio!.image).toStartWith("minio/minio:");
});
