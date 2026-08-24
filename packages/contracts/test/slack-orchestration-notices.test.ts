import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_SLACK_ORCHESTRATION_NOTICE_SETTINGS,
  resolveWorkspaceMemoryEnabled,
  resolveWorkspaceSlackOrchestrationNoticeSettings,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
} from "../src";

describe("Slack orchestration notice workspace settings", () => {
  test("both notices default off when nothing is configured", () => {
    for (const settings of [undefined, null, {}, { slackOrchestrationNotices: {} }]) {
      expect(resolveWorkspaceSlackOrchestrationNoticeSettings(settings)).toEqual({
        childRequiresAction: false,
        goalPaused: false,
      });
    }
    expect(DEFAULT_WORKSPACE_SLACK_ORCHESTRATION_NOTICE_SETTINGS).toEqual({
      childRequiresAction: false,
      goalPaused: false,
    });
  });

  test("only an explicit true turns a notice on, and each notice is independent", () => {
    expect(
      resolveWorkspaceSlackOrchestrationNoticeSettings({
        slackOrchestrationNotices: { childRequiresAction: true },
      }),
    ).toEqual({ childRequiresAction: true, goalPaused: false });
    expect(
      resolveWorkspaceSlackOrchestrationNoticeSettings({
        slackOrchestrationNotices: { goalPaused: true },
      }),
    ).toEqual({ childRequiresAction: false, goalPaused: true });
    expect(
      resolveWorkspaceSlackOrchestrationNoticeSettings({
        slackOrchestrationNotices: { childRequiresAction: true, goalPaused: true },
      }),
    ).toEqual({ childRequiresAction: true, goalPaused: true });
    expect(
      resolveWorkspaceSlackOrchestrationNoticeSettings({
        slackOrchestrationNotices: { childRequiresAction: false, goalPaused: false },
      }),
    ).toEqual({ childRequiresAction: false, goalPaused: false });
  });

  test("malformed and partially invalid settings fail closed to both disabled", () => {
    for (const configured of [
      "on",
      1,
      [],
      null,
      { childRequiresAction: "true" },
      { goalPaused: "yes" },
      // A valid enable next to one invalid sibling still resolves to silence:
      // an unsolicited Slack post is worse than a missed one.
      { childRequiresAction: true, goalPaused: "yes" },
    ]) {
      expect(
        resolveWorkspaceSlackOrchestrationNoticeSettings({
          slackOrchestrationNotices: configured,
        }),
      ).toEqual({ childRequiresAction: false, goalPaused: false });
    }
    // A settings bag that is not an object at all resolves the same way.
    expect(resolveWorkspaceSlackOrchestrationNoticeSettings("nonsense")).toEqual({
      childRequiresAction: false,
      goalPaused: false,
    });
  });

  test("a notice key a newer release added is ignored, not treated as malformed", () => {
    // The stored object is a KNOWN key of the settings bag, so rejecting an
    // unrecognized notice would reject the whole bag and revert every unrelated
    // workspace setting. Rolling back past a third notice must not cost that.
    expect(
      resolveWorkspaceSlackOrchestrationNoticeSettings({
        memoryEnabled: true,
        slackOrchestrationNotices: { childRequiresAction: true, turnFailed: true },
      }),
    ).toEqual({ childRequiresAction: true, goalPaused: false });
    expect(
      resolveWorkspaceMemoryEnabled({
        memoryEnabled: true,
        slackOrchestrationNotices: { childRequiresAction: true, turnFailed: true },
      }),
    ).toBe(true);
  });

  test("the key round-trips through the settings schema and the PATCH body", () => {
    const enabled = { childRequiresAction: true, goalPaused: true };
    expect(
      WorkspaceSettingsSchema.parse({ slackOrchestrationNotices: enabled })
        .slackOrchestrationNotices,
    ).toEqual(enabled);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ slackOrchestrationNotices: enabled }).success,
    ).toBe(true);
    // The PATCH body rejects what the resolver would have had to fail closed on,
    // so an invalid write never lands in the stored bag in the first place.
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        slackOrchestrationNotices: { childRequiresAction: "true" },
      }).success,
    ).toBe(false);
    // An unrecognized notice key is stripped on write rather than rejected, so
    // a newer client and this release can address the same workspace.
    const forwardCompatible = UpdateWorkspaceSettingsRequest.safeParse({
      slackOrchestrationNotices: { childRequiresAction: true, turnFailed: true },
    });
    expect(forwardCompatible.success).toBe(true);
    expect(forwardCompatible.data?.slackOrchestrationNotices).toEqual({
      childRequiresAction: true,
    });
  });

  test("an unrelated setting is unaffected by the notices being absent", () => {
    expect(
      resolveWorkspaceMemoryEnabled({
        memoryEnabled: true,
        slackOrchestrationNotices: { goalPaused: true },
      }),
    ).toBe(true);
  });
});
