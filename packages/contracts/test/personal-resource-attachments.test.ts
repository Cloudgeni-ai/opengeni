import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING,
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION,
  PersonalResourceAttachmentSummary,
  SessionUserMessagePayload,
  SteerSessionMessageRequest,
  SubmitComposerDraftRequest,
} from "../src";

const establishedAttachment = {
  mode: "once" as const,
  expectedAuthorityEpoch: 3,
  workspaceSharedAcknowledged: true,
  sharedOutputWarningVersion: 1 as const,
};

describe("atomic personal-resource attachment contracts", () => {
  test("publishes one fixed warning receipt version", () => {
    expect(PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION).toBe(1);
    expect(PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING).toContain(
      "may influence outputs visible to other workspace members",
    );
    expect(PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING).toContain(
      "credentials and secret values are not shared",
    );
  });

  test("projects a selected Connected Machine in the credential-free summary", () => {
    expect(
      PersonalResourceAttachmentSummary.parse({
        mode: "once",
        context: "workspace_shared",
        resourceCount: 1,
        resourceKinds: ["connected_machine"],
        sharedOutputWarningVersion: 1,
      }).resourceKinds,
    ).toEqual(["connected_machine"]);
  });

  test("lets create bind the epoch server-side but rejects realtime staging", () => {
    expect(
      CreateSessionRequest.parse({
        initialMessage: "use my fixed resources",
        personalResourceAttachment: {
          mode: "once",
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      }).personalResourceAttachment,
    ).toMatchObject({ mode: "once", workspaceSharedAcknowledged: true });
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "use my fixed resources",
        personalResourceAttachment: establishedAttachment,
      }).success,
    ).toBe(false);
    expect(
      CreateSessionRequest.safeParse({
        startMode: "realtime",
        personalResourceAttachment: {
          mode: "session",
          sharedOutputWarningVersion: 1,
        },
      }).success,
    ).toBe(false);
  });

  test("requires the expected epoch on every established-session surface", () => {
    const withoutEpoch = {
      mode: "session" as const,
      sharedOutputWarningVersion: 1 as const,
    };
    expect(
      SessionUserMessagePayload.safeParse({
        text: "send",
        personalResourceAttachment: withoutEpoch,
      }).success,
    ).toBe(false);
    expect(
      SteerSessionMessageRequest.safeParse({
        text: "steer",
        personalResourceAttachment: withoutEpoch,
      }).success,
    ).toBe(false);
    expect(
      SubmitComposerDraftRequest.safeParse({
        text: "submit",
        annotations: [],
        resources: [],
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        expectedDraftRevision: 1,
        clientEventId: "attachment-test",
        delivery: "send",
        personalResourceAttachment: withoutEpoch,
      }).success,
    ).toBe(false);

    expect(
      SessionUserMessagePayload.parse({
        text: "send",
        personalResourceAttachment: establishedAttachment,
      }).personalResourceAttachment,
    ).toEqual(establishedAttachment);
  });
});
