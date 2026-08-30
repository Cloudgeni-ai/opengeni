import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";

import { createAppSourceDownloadSignature } from "../src/apps-application";

const settings = testSettings({ appHostResolverKey: "k".repeat(64) });
const input = {
  authority: {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    subjectId: "human:one",
  },
  appId: "33333333-3333-4333-8333-333333333333",
  sourceRevisionId: "44444444-4444-4444-8444-444444444444",
  expiresAtSeconds: 1_788_112_300,
} as const;

describe("App source download grants", () => {
  test("are deterministic and bind tenant, subject, source, and expiry", () => {
    const signature = createAppSourceDownloadSignature(settings, input);

    expect(signature).toMatch(/^[0-9a-f]{64}$/u);
    expect(createAppSourceDownloadSignature(settings, input)).toBe(signature);
    expect(
      createAppSourceDownloadSignature(settings, {
        ...input,
        authority: { ...input.authority, subjectId: "human:two" },
      }),
    ).not.toBe(signature);
    expect(
      createAppSourceDownloadSignature(settings, {
        ...input,
        expiresAtSeconds: input.expiresAtSeconds + 1,
      }),
    ).not.toBe(signature);
  });

  test("fails closed when Apps download signing is not configured", () => {
    expect(() =>
      createAppSourceDownloadSignature(testSettings({ appHostResolverKey: undefined }), input),
    ).toThrow("Apps download signing is not configured");
  });
});
