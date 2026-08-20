import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { scheduledConnectionSurfaceEligibility } from "../src/domain/scheduled-tasks";

const googleTools = ["editable_artifact_export", "editable_artifact_export_status"] as const;

const connectorPermissions = ["artifacts:read", "artifacts:publish", "connections:read"] as const;

describe("scheduled connection-authority surface eligibility", () => {
  test("uses subject-expanded runtime defaults for scheduler-created sessions", () => {
    const rawSettings = testSettings({ defaultFirstPartyMcpTools: [] });
    const runtimeSettings = testSettings({
      defaultFirstPartyMcpTools: [...googleTools, "atlassian_search"],
    });

    expect(scheduledConnectionSurfaceEligibility(rawSettings, null)).toEqual({
      googleDrivePublicationEnabled: false,
      atlassianEnabled: false,
    });
    expect(scheduledConnectionSurfaceEligibility(runtimeSettings, null)).toEqual({
      googleDrivePublicationEnabled: true,
      atlassianEnabled: true,
    });
  });

  test("an existing-session target overrides deployment defaults", () => {
    const defaultOn = testSettings({
      defaultFirstPartyMcpTools: [...googleTools, "atlassian_search"],
    });
    const targetOff: Pick<Session, "firstPartyMcpTools" | "firstPartyMcpPermissions"> = {
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [...connectorPermissions],
    };
    expect(scheduledConnectionSurfaceEligibility(defaultOn, targetOff)).toEqual({
      googleDrivePublicationEnabled: false,
      atlassianEnabled: false,
    });

    const defaultOff = testSettings({ defaultFirstPartyMcpTools: [] });
    const targetOn: Pick<Session, "firstPartyMcpTools" | "firstPartyMcpPermissions"> = {
      firstPartyMcpTools: [...googleTools, "atlassian_search"],
      firstPartyMcpPermissions: [...connectorPermissions],
    };
    expect(scheduledConnectionSurfaceEligibility(defaultOff, targetOn)).toEqual({
      googleDrivePublicationEnabled: true,
      atlassianEnabled: true,
    });
  });
});
