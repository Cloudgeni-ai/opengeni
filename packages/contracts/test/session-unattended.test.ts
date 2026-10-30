import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  messageSentByPerson,
  PERSON_MESSAGE_SURFACES,
  resolveSessionUnattended,
  ScheduledTaskAgentConfig,
  ScheduledTaskAgentConfigInput,
  SESSION_UNATTENDED_METADATA_KEY,
  scheduledTaskRunUnattendedSetting,
  sessionMetadataUnattended,
  UpdateSessionUnattendedRequest,
  withSessionUnattendedMetadata,
} from "../src/index";

describe("unattended session create option", () => {
  test("is optional and boolean", () => {
    expect(CreateSessionRequest.parse({ initialMessage: "Run" }).unattended).toBeUndefined();
    expect(CreateSessionRequest.parse({ initialMessage: "Run", unattended: true }).unattended).toBe(
      true,
    );
    expect(() =>
      CreateSessionRequest.parse({ initialMessage: "Run", unattended: "yes" }),
    ).toThrow();
  });

  test("only the explicit option sets the reserved metadata key", () => {
    const supplied = { team: "ops", [SESSION_UNATTENDED_METADATA_KEY]: true };
    expect(withSessionUnattendedMetadata(supplied, false)).toEqual({ team: "ops" });
    expect(withSessionUnattendedMetadata({ team: "ops" }, true)).toEqual(supplied);
    expect(sessionMetadataUnattended(withSessionUnattendedMetadata({}, true))).toBe(true);
  });

  test("reads true only for an exact true value", () => {
    expect(sessionMetadataUnattended(undefined)).toBe(false);
    expect(sessionMetadataUnattended(null)).toBe(false);
    expect(sessionMetadataUnattended([])).toBe(false);
    expect(sessionMetadataUnattended({ [SESSION_UNATTENDED_METADATA_KEY]: "true" })).toBe(false);
    expect(sessionMetadataUnattended({ [SESSION_UNATTENDED_METADATA_KEY]: true })).toBe(true);
  });
});

describe("scheduled and event-triggered runs", () => {
  test("are unattended unless the task says otherwise or answers its approvals", () => {
    expect(scheduledTaskRunUnattendedSetting({})).toBe("unattended_by_default");
    expect(scheduledTaskRunUnattendedSetting({ unattended: false })).toBe("attended");
    expect(scheduledTaskRunUnattendedSetting({ approvalTimeoutSeconds: 600 })).toBeNull();
    expect(
      scheduledTaskRunUnattendedSetting({ approvalTimeoutSeconds: 600, unattended: true }),
    ).toBe("unattended");
    expect(scheduledTaskRunUnattendedSetting({ unattended: true })).toBe("unattended");
  });

  test("the task option is an optional boolean on stored and request config", () => {
    for (const schema of [ScheduledTaskAgentConfig, ScheduledTaskAgentConfigInput]) {
      expect(schema.parse({ prompt: "Run" }).unattended).toBeUndefined();
      expect(schema.parse({ prompt: "Run", unattended: false }).unattended).toBe(false);
      expect(() => schema.parse({ prompt: "Run", unattended: "no" })).toThrow();
    }
  });

  test("only a person writing through a person surface counts as a person", () => {
    expect([...PERSON_MESSAGE_SURFACES].sort()).toEqual(["slack", "voice", "web"]);
    for (const surface of ["web", "slack", "voice"] as const) {
      expect(messageSentByPerson({ source: "user", surface })).toBe(true);
    }
    for (const surface of [
      "api_key",
      "embedded",
      "agent",
      "scheduled",
      "automation",
      null,
    ] as const) {
      expect(messageSentByPerson({ source: "user", surface })).toBe(false);
    }
    expect(messageSentByPerson({ source: "api", surface: "web" })).toBe(false);
  });
});

describe("a chat's unattended setting", () => {
  const read = (
    setting: Parameters<typeof resolveSessionUnattended>[0]["setting"],
    createdUnattended = false,
    forked = false,
  ) => resolveSessionUnattended({ setting, createdUnattended, forked });

  test("an explicit choice wins over the create option, also in a fork", () => {
    for (const created of [false, true]) {
      for (const forked of [false, true]) {
        expect(read("unattended", created, forked)).toBe(true);
        expect(read("attended", created, forked)).toBe(false);
      }
    }
  });

  test("without a choice the create option or an automation default decides", () => {
    expect(read(null)).toBe(false);
    expect(read(null, true)).toBe(true);
    expect(read("unattended_by_default")).toBe(true);
    // A person makes a fork: neither carries over.
    expect(read(null, true, true)).toBe(false);
    expect(read("unattended_by_default", false, true)).toBe(false);
  });

  test("the switch request is a boolean", () => {
    expect(UpdateSessionUnattendedRequest.parse({ unattended: true })).toEqual({
      unattended: true,
    });
    expect(() => UpdateSessionUnattendedRequest.parse({})).toThrow();
    expect(() => UpdateSessionUnattendedRequest.parse({ unattended: true, extra: 1 })).toThrow();
  });
});
