import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("desktop Modal image pin", () => {
  test("chart values expose a first-class digest pin that overwrites the ConfigMap", async () => {
    const values = await source("../values.yaml");
    const helpers = await source("../templates/_helpers.tpl");
    const configmap = await source("../templates/configmap.yaml");

    expect(values).toContain('desktop:\n  imageRef: ""');
    expect(helpers).toContain("opengeni.assertDesktopModalImagePin");
    expect(helpers).toContain("docker/desktop.Dockerfile");
    expect(configmap).toContain("opengeni.assertDesktopModalImagePin");
    expect(configmap).toContain("OPENGENI_MODAL_IMAGE_REF: {{ $desktopImageRef | quote }}");
  });

  test("preview managed example documents the digest pin, not a floating tag", async () => {
    const preview = await source("../values.preview-managed.example.yaml");
    expect(preview).toContain("desktop.imageRef");
    expect(preview).toContain("docker/desktop.Dockerfile");
  });
});
