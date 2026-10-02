import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  autoApprovalForbidden,
  type IntegrationDefinition,
} from "@opengeni/capabilities";
import type { AccessGrant, InstallApiIntegrationRequest } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { validatedIntegrationInstallInput } from "../src/routes/api-integrations";
import type { ResolvedApiIntegrationPreview } from "../src/integrations/api-integrations";

const grant = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:admin",
  permissions: ["capabilities:manage"],
} as AccessGrant;

function resolved(definitionProvenance: "curated" | "workspace"): ResolvedApiIntegrationPreview {
  return {
    preview: {
      definitionId: definitionProvenance === "curated" ? "google-drive" : "custom-1",
      definitionProvenance,
      revisionId: "rev",
      contentSha256: "a".repeat(64),
      auth: { kind: "none" },
      connectionOwnership: null,
      tools: [
        { id: "drive_files_list", operationKey: "drive.files.list", approvalMode: "never" },
        { id: "drive_files_update", operationKey: "drive.files.update", approvalMode: "ask" },
      ],
    },
    revision: {},
  } as unknown as ResolvedApiIntegrationPreview;
}

const request = (autoApprovedTools: string[]) =>
  ({
    source: { kind: "definition", definitionId: "google-drive" },
    expectedRevisionId: "rev",
    expectedContentSha256: "a".repeat(64),
    autoApprovedTools,
  }) as InstallApiIntegrationRequest;

describe("autoApprovedTools governance", () => {
  test("curated Integrations follow the same rule as custom ones by default", () => {
    for (const provenance of ["curated", "workspace"] as const) {
      const input = validatedIntegrationInstallInput(
        grant,
        grant.workspaceId,
        request(["drive_files_update"]),
        resolved(provenance),
      );
      expect(input.autoApprovedTools).toEqual(["drive_files_update"]);
    }
  });

  test("an unselected tool is refused", () => {
    expect(() =>
      validatedIntegrationInstallInput(
        grant,
        grant.workspaceId,
        { ...request(["drive_files_update"]), allowedTools: ["drive_files_list"] },
        resolved("workspace"),
      ),
    ).toThrow(HTTPException);
  });

  test("a curated definition can forbid exempting specific operations", () => {
    const governed: IntegrationDefinition = {
      ...GOOGLE_DRIVE_INTEGRATION_DEFINITION,
      autoApproval: { forbiddenOperationKeys: ["drive.files.update"] },
    };
    expect(autoApprovalForbidden(governed, "drive.files.update")).toBe(true);
    expect(autoApprovalForbidden(governed, "drive.files.delete")).toBe(false);
    expect(
      autoApprovalForbidden(
        { ...governed, autoApproval: { forbiddenOperationKeys: "all" } },
        "anything",
      ),
    ).toBe(true);
    expect(autoApprovalForbidden(GOOGLE_DRIVE_INTEGRATION_DEFINITION, "drive.files.update")).toBe(
      false,
    );
  });
});
