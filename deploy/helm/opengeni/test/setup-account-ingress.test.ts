import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("managed setup-account ingress", () => {
  test("uses an exact no-access-log location for the mail-compatible query bearer", async () => {
    const values = await source("../values.yaml");
    const ingress = await source("../templates/ingress.yaml");

    expect(values).toContain(
      'setupAccountIngress:\n    enabled: true\n    annotations:\n      nginx.ingress.kubernetes.io/enable-access-log: "false"',
    );
    expect(ingress).toContain(
      '.Values.ingress.setupAccountIngress.enabled .Values.web.enabled (eq .Values.config.OPENGENI_PRODUCT_ACCESS_MODE "managed")',
    );
    expect(ingress).toContain('name: {{ include "opengeni.fullname" . }}-setup-account');
    expect(ingress).toContain("- path: /setup-account\n            pathType: Exact");
    expect(ingress).toContain("with .Values.ingress.setupAccountIngress.annotations");
  });
});
