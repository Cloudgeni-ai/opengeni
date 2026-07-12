import { describe, expect, test } from "bun:test";
import {
  loadWorkflowDocuments,
  releasePublisherFindings,
  type WorkflowDocument,
} from "./check-single-release-publisher";

describe("single out-of-band runtime publisher", () => {
  test("keeps every app workflow free of chart and runtime-image publication", () => {
    expect(releasePublisherFindings(loadWorkflowDocuments())).toEqual([]);
  });

  for (const artifact of ["chart", "api", "worker", "web", "relay"] as const) {
    test(`fails closed when the legacy workflow tries to publish ${artifact}`, () => {
      const workflow =
        artifact === "chart"
          ? fixture({ run: "helm push opengeni.tgz oci://ghcr.io/cloudgeni-ai/charts" })
          : fixture({
              uses: "docker/build-push-action@0000000000000000000000000000000000000000",
              with: {
                push: true,
                tags: `ghcr.io/cloudgeni-ai/opengeni-${artifact}:1.2.3`,
              },
            });
      const reasons = releasePublisherFindings([workflow]).map((finding) => finding.reason);
      expect(reasons.length).toBeGreaterThan(0);
      expect(
        reasons.some(
          (reason) =>
            reason.includes("sole publisher") ||
            reason.includes("registry push") ||
            reason.includes("publication target"),
        ),
      ).toBe(true);
    });
  }

  test("rejects package-registry write permission and floating npm release actions", () => {
    const findings = releasePublisherFindings([
      {
        file: ".github/workflows/release.yml",
        document: {
          jobs: {
            release: {
              permissions: { packages: "write" },
              steps: [{ uses: "changesets/action@v1" }],
            },
          },
        },
      },
    ]);
    expect(findings.map((finding) => finding.reason)).toEqual([
      "app workflows may not receive package-registry write permission",
      "npm release action is not pinned to a full commit SHA: changesets/action@v1",
    ]);
  });
});

function fixture(step: Record<string, unknown>): WorkflowDocument {
  return {
    file: ".github/workflows/legacy-runtime-publisher.yml",
    document: { jobs: { publish: { steps: [step] } } },
  };
}
