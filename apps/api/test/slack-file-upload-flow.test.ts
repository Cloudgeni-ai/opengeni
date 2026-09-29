import { describe, expect, test } from "bun:test";
import {
  assertSlackPrivateTaskRecipient,
  slackFileSharedToThread,
  slackFileUploadUrl,
} from "../src/integrations/slack-bot";
import {
  runSlackFileUpload,
  SlackFileUploadClaimLostError,
  SlackFileUploadOutcomeUnknownError,
  type SlackFileUploadPhase,
  type SlackFileUploadProvider,
} from "../src/integrations/slack-file-upload-flow";

function fixture(phase: SlackFileUploadPhase = "pending", id: string | null = null) {
  const events: string[] = [];
  const state = { phase, slackFileId: id };
  let shared = true;
  let rejectCheckpoint: SlackFileUploadPhase | null = null;
  let completeFailure = false;
  const provider: SlackFileUploadProvider = {
    async allocateFileUpload() {
      events.push("allocate");
      return { fileId: "FNEW", uploadUrl: new URL("https://files.slack.com/upload/v1/temporary") };
    },
    async transferFileUpload() {
      events.push("transfer");
    },
    async completeFileUpload(input) {
      events.push(`complete:${input.fileId}`);
      if (completeFailure) throw new Error("provider response interrupted");
    },
    async reconcileFileUpload(input) {
      events.push(`reconcile:${input.fileId}`);
      return { shared };
    },
  };
  const input = {
    state,
    provider,
    channelId: "CTASK",
    threadTimestamp: "1790601997.581739",
    filename: "palette.png",
    bytes: new Uint8Array([1, 2, 3]),
    async checkpoint(update: {
      expectedPhase: SlackFileUploadPhase;
      phase: SlackFileUploadPhase;
      slackFileId?: string;
    }) {
      events.push(`checkpoint:${update.phase}`);
      expect(update.expectedPhase).toBe(state.phase);
      expect(Object.keys(update).sort()).toEqual(
        update.slackFileId ? ["expectedPhase", "phase", "slackFileId"] : ["expectedPhase", "phase"],
      );
      if (rejectCheckpoint === update.phase) return false;
      state.phase = update.phase;
      if (update.slackFileId) state.slackFileId = update.slackFileId;
      return true;
    },
  };
  return {
    input,
    state,
    events,
    setShared: (value: boolean) => {
      shared = value;
    },
    reject: (value: SlackFileUploadPhase) => {
      rejectCheckpoint = value;
    },
    failCompletion: () => {
      completeFailure = true;
    },
  };
}

describe("durable Slack file delivery flow", () => {
  test("checkpoints provider identity before transfer and completion before sharing", async () => {
    const f = fixture();
    expect(await runSlackFileUpload(f.input)).toEqual({ slackFileId: "FNEW", replayed: false });
    expect(f.events).toEqual([
      "allocate",
      "checkpoint:uploading",
      "transfer",
      "checkpoint:uploaded",
      "checkpoint:completing",
      "complete:FNEW",
      "checkpoint:completed",
    ]);
  });

  test("replays a completed operation without any provider I/O", async () => {
    const f = fixture("completed", "FDONE");
    expect(await runSlackFileUpload(f.input)).toEqual({ slackFileId: "FDONE", replayed: true });
    expect(f.events).toEqual([]);
  });

  test("resumes uploaded bytes without allocating or retransferring", async () => {
    const f = fixture("uploaded", "FUPLOADED");
    await runSlackFileUpload(f.input);
    expect(f.events).toEqual([
      "checkpoint:completing",
      "complete:FUPLOADED",
      "checkpoint:completed",
    ]);
  });

  for (const phase of ["completing", "outcome_unknown"] as const) {
    test(`${phase} reconciles the stable file rather than completing again`, async () => {
      const f = fixture(phase, "FEXISTING");
      expect(await runSlackFileUpload(f.input)).toEqual({
        slackFileId: "FEXISTING",
        replayed: true,
      });
      expect(f.events).toEqual(["reconcile:FEXISTING", "checkpoint:completed"]);
    });

    test(`${phase} never resends when Slack cannot prove delivery`, async () => {
      const f = fixture(phase, "FEXISTING");
      f.setShared(false);
      await expect(runSlackFileUpload(f.input)).rejects.toBeInstanceOf(
        SlackFileUploadOutcomeUnknownError,
      );
      expect(f.events).toEqual(["reconcile:FEXISTING"]);
    });
  }

  test("a lost allocation checkpoint prevents byte transfer", async () => {
    const f = fixture();
    f.reject("uploading");
    await expect(runSlackFileUpload(f.input)).rejects.toBeInstanceOf(SlackFileUploadClaimLostError);
    expect(f.events).toEqual(["allocate", "checkpoint:uploading"]);
  });

  test("a lost completion checkpoint prevents the sharing call", async () => {
    const f = fixture("uploaded", "FUPLOADED");
    f.reject("completing");
    await expect(runSlackFileUpload(f.input)).rejects.toBeInstanceOf(SlackFileUploadClaimLostError);
    expect(f.events).toEqual(["checkpoint:completing"]);
  });

  test("an incomplete transfer may replace only the unshared allocated file", async () => {
    const f = fixture("uploading", "FOLDUNSHARED");
    expect(await runSlackFileUpload(f.input)).toEqual({ slackFileId: "FNEW", replayed: false });
    expect(f.events).not.toContain("complete:FOLDUNSHARED");
    expect(f.events).toContain("complete:FNEW");
  });

  test("private recipient identity follows allocation, transfer, completion and reconciliation", async () => {
    for (const phase of ["pending", "outcome_unknown"] as const) {
      const f = fixture(phase, phase === "pending" ? null : "FEXISTING");
      const checked: string[] = [];
      for (const method of [
        "allocateFileUpload",
        "transferFileUpload",
        "completeFileUpload",
        "reconcileFileUpload",
      ] as const) {
        const original = f.input.provider[method];
        f.input.provider[method] = (async (input: never) => {
          expect(input).toMatchObject({ privateRecipientSlackUserId: "UOWNER" });
          checked.push(method);
          return await original(input);
        }) as typeof original;
      }
      await runSlackFileUpload({ ...f.input, privateRecipientSlackUserId: "UOWNER" });
      expect(checked).toEqual(
        phase === "pending"
          ? ["allocateFileUpload", "transferFileUpload", "completeFileUpload"]
          : ["reconcileFileUpload"],
      );
    }
  });

  test("a transport error after starting completion remains uncertain and is not retried", async () => {
    const f = fixture("uploaded", "FUPLOADED");
    f.failCompletion();
    await expect(runSlackFileUpload(f.input)).rejects.toThrow("provider response interrupted");
    expect(f.state.phase).toBe("completing");
    expect(f.events.filter((event) => event.startsWith("complete:"))).toHaveLength(1);
    const retry = fixture("outcome_unknown", "FUPLOADED");
    await runSlackFileUpload(retry.input);
    expect(retry.events).toEqual(["reconcile:FUPLOADED", "checkpoint:completed"]);
  });
});

describe("Slack file upload provider boundaries", () => {
  test("private delivery accepts only the linked requester's live bot IM", () => {
    const ownerIm = { isDirectMessage: true, isMpim: false, userId: "UOWNER" };
    expect(() => assertSlackPrivateTaskRecipient(ownerIm, "UOWNER")).not.toThrow();
    for (const channel of [
      { ...ownerIm, isDirectMessage: false, isMpim: true },
      { ...ownerIm, isDirectMessage: false },
      { ...ownerIm, userId: "UOTHER" },
      { ...ownerIm, userId: null },
    ]) {
      expect(() => assertSlackPrivateTaskRecipient(channel, "UOWNER")).toThrow(
        "private_task_recipient_changed",
      );
    }
  });

  test("accepts only a temporary Slack HTTPS upload endpoint", () => {
    expect(
      slackFileUploadUrl("https://files.slack.com/upload/v1/temporary?signature=fixture").hostname,
    ).toBe("files.slack.com");
    for (const value of [
      "https://example.test/upload/v1/file",
      "https://files.slack.com.evil.test/upload/v1/file",
      "http://files.slack.com/upload/v1/file",
      "https://files.slack.com:444/upload/v1/file",
      "https://secret@files.slack.com/upload/v1/file",
      "https://files.slack.com/api/file",
      "https://files.slack.com/upload/v1/file#secret",
      "not a URL",
    ])
      expect(() => slackFileUploadUrl(value)).toThrow("invalid_upload_url");
  });

  test("reconciliation needs exact file, bot principal, channel and thread", () => {
    const input = {
      fileId: "FEXACT",
      botUserId: "UBOT",
      channelId: "CTASK",
      threadTimestamp: "1790601997.581739",
    };
    const file = {
      id: input.fileId,
      user: input.botUserId,
      channels: [input.channelId],
      shares: {
        public: {
          [input.channelId]: [{ thread_ts: input.threadTimestamp, ts: "1790604320.123456" }],
        },
      },
    };
    expect(slackFileSharedToThread(file, input)).toBe(true);
    expect(
      slackFileSharedToThread({ ...file, shares: { private: file.shares.public } }, input),
    ).toBe(true);
    expect(slackFileSharedToThread({ ...file, shares: {} }, input)).toBe(false);
    expect(slackFileSharedToThread(file, { ...input, threadTimestamp: "1.1" })).toBe(false);
    expect(slackFileSharedToThread(file, { ...input, channelId: "COTHER" })).toBe(false);
    expect(slackFileSharedToThread(file, { ...input, fileId: "FOTHER" })).toBe(false);
    expect(slackFileSharedToThread(file, { ...input, botUserId: "UOTHER" })).toBe(false);
  });
});
