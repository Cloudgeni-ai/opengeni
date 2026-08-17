import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RigOverview } from "./rig-overview";
import type { Rig, RigProviderImage } from "@/types";

const now = "2026-08-14T12:00:00.000Z";

function providerImage(
  status: RigProviderImage["status"],
  error: RigProviderImage["error"] = null,
): RigProviderImage {
  return {
    backend: "modal",
    provider: "modal",
    status,
    contentHash: `sha256:${"a".repeat(64)}`,
    setupHash: `sha256:${"b".repeat(64)}`,
    sourceImage: "ubuntu:24.04",
    buildRequestId: "11111111-1111-4111-8111-111111111111",
    imageId: status === "ready" ? "im-ready" : null,
    imageDigest: null,
    artifactId: status === "ready" ? "22222222-2222-4222-8222-222222222222" : null,
    providerBindingKeyHash: status === "ready" ? `sha256:${"c".repeat(64)}` : null,
    ...(status === "ready" ? { coldBootValidation: { version: 1, checkedAt: now } } : {}),
    provenance: {
      kind: "rig_verification",
      targetKind: "version",
      targetId: "33333333-3333-4333-8333-333333333333",
    },
    startedAt: now,
    finishedAt: status === "building" ? null : now,
    error,
  };
}

function rig(image?: RigProviderImage): Rig {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    accountId: "55555555-5555-4555-8555-555555555555",
    workspaceId: "66666666-6666-4666-8666-666666666666",
    name: "Large rig",
    description: null,
    createdBy: "user:test",
    activeVersion: {
      id: "33333333-3333-4333-8333-333333333333",
      rigId: "44444444-4444-4444-8444-444444444444",
      version: 1,
      image: "ubuntu:24.04",
      setupScript: "echo exact setup",
      checks: [],
      credentialHooks: [],
      defaultVariableSetIds: [],
      changelog: null,
      providerImages: image ? { modal: image } : {},
      createdBy: "user:test",
      active: true,
      createdAt: now,
    },
    activeVersionHealth: { checkHealth: "unknown", lastVerifiedAt: null },
    versionCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function render(value: Rig): string {
  return renderToStaticMarkup(
    <RigOverview
      rig={value}
      changes={[]}
      variableSetName={(id) => id}
      canUse={false}
      mutating={false}
      onVerify={async () => null}
    />,
  );
}

describe("RigOverview provider image truth", () => {
  test("explains the complete setup fallback when no provider image exists", () => {
    const markup = render(rig());
    expect(markup).toContain("No provider image prepared yet");
    expect(markup).toContain("No rig content is skipped");
  });

  test("renders active preparation and a recorded terminal error distinctly", () => {
    expect(render(rig(providerImage("building")))).toContain("Preparing image");

    const failed = providerImage("failed", {
      code: "provider_build_failed",
      message: "Provider capacity unavailable",
      retryable: true,
    });
    const markup = render(rig(failed));
    expect(markup).toContain("Image build failed");
    expect(markup).toContain("Provider capacity unavailable");
  });
});
